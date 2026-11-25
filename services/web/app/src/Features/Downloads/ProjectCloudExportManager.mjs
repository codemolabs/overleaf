import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import archiver from 'archiver'
import logger from '@overleaf/logger'
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs'
import HistoryManager from '../History/HistoryManager.mjs'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import ProjectGetter from '../Project/ProjectGetter.mjs'

const execFileAsync = promisify(execFile)

const CLOUD_EXPORT_ROOT = path.resolve(
  process.env.OVERLEAF_CLOUD_EXPORT_TMP_DIR || '/tmp/overleaf-cloud-export'
)
const OPTIMIZER_SCRIPT = path.join(import.meta.dirname, 'cloud_zip_optimize.py')
const JOB_TTL_MS = 10 * 60 * 1000
const MAX_ACTIVE_JOBS = 40
const DEFAULT_TARGET_MB = 25
const MIN_TARGET_MB = 5
const MAX_TARGET_MB = 30

const IMAGE_EXT_SEARCH_ORDER = [
  '',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.eps',
  '.svg',
  '.PDF',
  '.PNG',
  '.JPG',
  '.JPEG',
]

const SCRIPT_EXTS = new Set([
  '.py',
  '.ipynb',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.bat',
  '.cmd',
  '.r',
  '.js',
  '.mjs',
  '.ts',
])

const BUILD_ARTIFACT_EXTS = new Set([
  '.aux',
  '.log',
  '.out',
  '.bbl',
  '.blg',
  '.fls',
  '.fdb_latexmk',
  '.synctex',
  '.toc',
  '.lof',
  '.lot',
  '.nav',
  '.snm',
  '.vrb',
  '.bcf',
  '.idx',
  '.ilg',
  '.ind',
  '.glo',
  '.gls',
  '.acn',
  '.acr',
  '.alg',
  '.bak',
  '.swp',
])

/** @type {Map<string, { jobId: string, projectId: string, userId: string, filename: string, zipPath: string, workDir: string, createdAt: number, expiresAt: number }>} */
const activeJobs = new Map()

function cleanupJobFiles(job) {
  if (!job) return
  try {
    fs.rmSync(job.workDir, { recursive: true, force: true })
  } catch {}
}

function purgeExpiredJobs() {
  const now = Date.now()
  for (const [id, job] of activeJobs.entries()) {
    if (now >= job.expiresAt) {
      activeJobs.delete(id)
      cleanupJobFiles(job)
    }
  }
  while (activeJobs.size >= MAX_ACTIVE_JOBS) {
    const oldestKey = activeJobs.keys().next().value
    if (!oldestKey) break
    const oldest = activeJobs.get(oldestKey)
    activeJobs.delete(oldestKey)
    cleanupJobFiles(oldest)
  }
}

const purgeTimer = setInterval(purgeExpiredJobs, 60 * 1000)
if (typeof purgeTimer.unref === 'function') {
  purgeTimer.unref()
}

function normalizeRelPath(rawPath) {
  const cleaned = path.posix
    .normalize(String(rawPath || '').replace(/\\/g, '/').trim())
    .replace(/^\/+/, '')
    .replace(/^\.\//, '')
  if (!cleaned || cleaned === '.' || cleaned.startsWith('../')) return ''
  return cleaned
}

function stripTexComments(content) {
  return String(content || '')
    .split(/\r\n|\n|\r/)
    .map(line => line.replace(/(?<!\\)(?:\\\\)*%.*/, m => m.slice(0, m.length - m.replace(/^\\*/, '').length)))
    .join('\n')
}

function resolveCandidatePaths(currentDir, rawRef, extraSearchDirs, extensions) {
  const ref = String(rawRef || '').trim()
  if (!ref || ref.includes('#') || ref.includes('*')) return []
  const candidates = []
  const searchDirs = Array.from(
    new Set([currentDir || '', '', ...extraSearchDirs].map(d => normalizeRelPath(d)))
  )
  for (const baseDir of searchDirs) {
    const joined = baseDir ? `${baseDir}/${ref}` : ref
    const norm = normalizeRelPath(joined)
    if (!norm) continue
    for (const ext of extensions) {
      if (ext && norm.toLowerCase().endsWith(ext.toLowerCase())) {
        candidates.push(norm)
      } else {
        candidates.push(ext ? `${norm}${ext}` : norm)
      }
    }
  }
  return Array.from(new Set(candidates))
}

function extractSimpleTexMacros(text) {
  const macros = new Map()
  const re = /\\(?:newcommand|renewcommand|providecommand)\*?\s*\{\\([a-zA-Z@]+)\}(?:\[\d+\])?\s*\{([^{}]+)\}/g
  let match
  while ((match = re.exec(text)) !== null) {
    macros.set(`\\${match[1]}`, match[2].trim())
  }
  const defRe = /\\def\\([a-zA-Z@]+)\s*\{([^{}]+)\}/g
  while ((match = defRe.exec(text)) !== null) {
    macros.set(`\\${match[1]}`, match[2].trim())
  }
  return macros
}

function expandSimpleMacros(arg, macros) {
  let out = String(arg || '').trim()
  for (const [name, val] of macros.entries()) {
    if (out.includes(name)) {
      out = out.split(name).join(val)
    }
  }
  return out
}

function buildEntityMaps(docsObj, filesObj) {
  const docs = new Map()
  for (const [rawKey, doc] of Object.entries(docsObj || {})) {
    const rel = normalizeRelPath(rawKey)
    if (rel) docs.set(rel, doc)
  }
  const files = new Map()
  for (const [rawKey, file] of Object.entries(filesObj || {})) {
    const rel = normalizeRelPath(rawKey)
    if (rel) files.set(rel, file)
  }
  return { docs, files }
}

function detectRootDocRel(project, docsMap) {
  if (project?.rootDoc_id) {
    const targetId = String(project.rootDoc_id)
    for (const [rel, doc] of docsMap.entries()) {
      if (String(doc?._id) === targetId) {
        return rel
      }
    }
  }
  if (docsMap.has('main.tex')) return 'main.tex'
  for (const [rel, doc] of docsMap.entries()) {
    if (!rel.toLowerCase().endsWith('.tex')) continue
    const text = Array.isArray(doc.lines) ? doc.lines.join('\n') : ''
    if (/\\documentclass(?:\[[^\]]*\])?\{/.test(text)) {
      return rel
    }
  }
  for (const rel of docsMap.keys()) {
    if (rel.toLowerCase().endsWith('.tex')) return rel
  }
  return docsMap.keys().next().value || null
}

function collectTexDependencies(rootRel, docsMap, filesMap) {
  const allKnownRel = new Set([...docsMap.keys(), ...filesMap.keys()])
  const byBasename = new Map()
  for (const rel of allKnownRel) {
    const base = path.posix.basename(rel)
    if (!byBasename.has(base)) byBasename.set(base, [])
    byBasename.get(base).push(rel)
  }

  const keptDocs = new Set()
  const keptFiles = new Set()
  const graphicsSearchDirs = new Set(['', 'figures', 'figs', 'images', 'img'])
  const macros = new Map()
  const queue = []

  const markEntity = rel => {
    if (!rel) return false
    if (docsMap.has(rel)) {
      if (!keptDocs.has(rel)) {
        keptDocs.add(rel)
        queue.push(rel)
      }
      return true
    }
    if (filesMap.has(rel)) {
      keptFiles.add(rel)
      return true
    }
    return false
  }

  const resolveFirst = (currentDir, rawRef, extensions, allowBasenameFallback = false) => {
    const expanded = expandSimpleMacros(rawRef, macros)
    const candidates = resolveCandidatePaths(
      currentDir,
      expanded,
      Array.from(graphicsSearchDirs),
      extensions
    )
    for (const cand of candidates) {
      if (markEntity(cand)) return cand
    }
    if (allowBasenameFallback && !expanded.includes('/')) {
      for (const ext of extensions) {
        const key = ext && !expanded.toLowerCase().endsWith(ext.toLowerCase()) ? `${expanded}${ext}` : expanded
        const hits = byBasename.get(key)
        if (hits && hits.length === 1 && markEntity(hits[0])) {
          return hits[0]
        }
      }
    }
    return null
  }

  if (rootRel) markEntity(rootRel)
  if (allKnownRel.has('latexmkrc')) markEntity('latexmkrc')

  while (queue.length > 0) {
    const rel = queue.shift()
    const doc = docsMap.get(rel)
    if (!doc) continue
    const rawText = Array.isArray(doc.lines) ? doc.lines.join('\n') : ''
    const stripped = stripTexComments(rawText)
    for (const [k, v] of extractSimpleTexMacros(stripped).entries()) {
      macros.set(k, v)
    }

    const currentDir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel)

    // \graphicspath{{dir1/}{dir2/}}
    const gpathRe = /\\graphicspath\s*\{((?:\s*\{[^{}]+\}\s*)+)\}/g
    let gpMatch
    while ((gpMatch = gpathRe.exec(stripped)) !== null) {
      const innerRe = /\{([^{}]+)\}/g
      let m2
      while ((m2 = innerRe.exec(gpMatch[1])) !== null) {
        const gp = normalizeRelPath(currentDir ? `${currentDir}/${m2[1]}` : m2[1])
        if (gp) graphicsSearchDirs.add(gp)
      }
    }

    // \documentclass{...}, \usepackage{a,b}, \RequirePackage{...}
    const clsPkgRe = /\\(documentclass|usepackage|RequirePackage|LoadClass)\*?(?:\[[^\]]*\])?\s*\{([^}]+)\}/g
    let cpMatch
    while ((cpMatch = clsPkgRe.exec(stripped)) !== null) {
      const ext = cpMatch[1] === 'documentclass' || cpMatch[1] === 'LoadClass' ? '.cls' : '.sty'
      for (const pkg of cpMatch[2].split(',')) {
        const trimmed = pkg.trim()
        if (trimmed) {
          resolveFirst(currentDir, trimmed, ['', ext], true)
        }
      }
    }

    // \input{...}, \include{...}, \subfile{...}
    const inputRe = /\\(?:input|include|subfile)\s*\{([^}]+)\}/g
    let inMatch
    while ((inMatch = inputRe.exec(stripped)) !== null) {
      resolveFirst(currentDir, inMatch[1], ['', '.tex'], false)
    }

    // \import{dir}{file}, \subimport{dir}{file}, \includefrom{dir}{file}
    const importRe = /\\(?:import|subimport|includefrom|subincludefrom)\s*\{([^}]*)\}\s*\{([^}]+)\}/g
    let imMatch
    while ((imMatch = importRe.exec(stripped)) !== null) {
      const combined = normalizeRelPath(`${imMatch[1]}/${imMatch[2]}`)
      resolveFirst(currentDir, combined, ['', '.tex'], false)
    }

    // \bibliography{a,b}, \addbibresource{...}, \bibliographystyle{...}
    const bibRe = /\\(bibliography|addbibresource|bibliographystyle)(?:\[[^\]]*\])?\s*\{([^}]+)\}/g
    let bibMatch
    while ((bibMatch = bibRe.exec(stripped)) !== null) {
      const ext = bibMatch[1] === 'bibliographystyle' ? '.bst' : '.bib'
      for (const b of bibMatch[2].split(',')) {
        const trimmed = b.trim()
        if (trimmed) {
          resolveFirst(currentDir, trimmed, ['', ext], true)
        }
      }
    }

    // \includegraphics[...]{...}, \includesvg[...]{...}, \includepdf[...]{...}
    const gfxRe = /\\(?:includegraphics|includesvg|includepdf|overpic)\*?(?:\[[^\]]*\])?\s*\{([^}]+)\}/g
    let gfxMatch
    while ((gfxMatch = gfxRe.exec(stripped)) !== null) {
      resolveFirst(currentDir, gfxMatch[1], IMAGE_EXT_SEARCH_ORDER, true)
    }

    // \lstinputlisting, \VerbatimInput, \inputminted
    const codeRe = /\\(?:lstinputlisting|VerbatimInput|verbatiminput|BVerbatimInput)(?:\[[^\]]*\])?\s*\{([^}]+)\}/g
    let cMatch
    while ((cMatch = codeRe.exec(stripped)) !== null) {
      resolveFirst(currentDir, cMatch[1], [''], false)
    }
    const mintedRe = /\\inputminted(?:\[[^\]]*\])?\s*\{[^}]*\}\s*\{([^}]+)\}/g
    let mMatch
    while ((mMatch = mintedRe.exec(stripped)) !== null) {
      resolveFirst(currentDir, mMatch[1], [''], false)
    }
  }

  return { keptDocs, keptFiles }
}

function classifyDroppedReason(relPath) {
  const lower = relPath.toLowerCase()
  const ext = path.posix.extname(lower)
  const base = path.posix.basename(lower)
  if (lower.endsWith('.synctex.gz') || lower.endsWith('.run.xml') || BUILD_ARTIFACT_EXTS.has(ext)) {
    return 'build_artifact'
  }
  if (ext === '.pdf') {
    return 'draft_or_local_pdf'
  }
  if (SCRIPT_EXTS.has(ext)) {
    return 'script_or_code'
  }
  if (ext === '.tex' || base.endsWith('.tex')) {
    return 'unused_tex'
  }
  return 'unreferenced_asset'
}

function sanitizeZipFilename(name) {
  const safe = String(name || 'overleaf_project')
    .replace(/[^\p{L}\p{Nd}_-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
  return `${safe || 'overleaf_project'}-cloud.zip`
}

async function createZipFromDirectory(sourceDir, outZipPath) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZipPath, { mode: 0o600 })
    const archive = archiver('zip', { zlib: { level: 9 } })
    output.on('close', resolve)
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    archive.directory(sourceDir, false)
    archive.finalize()
  })
}

async function createCloudZipJob(projectId, userId, options = {}) {
  const key = String(projectId)
  const ownerUserId = String(userId)

  const targetMaxMb = Math.min(
    MAX_TARGET_MB,
    Math.max(MIN_TARGET_MB, Number(options.targetMaxMb) || DEFAULT_TARGET_MB)
  )
  const targetBytes = Math.round(targetMaxMb * 1024 * 1024 * 0.96)
  const compressImages = options.compressImages !== false
  const pruneUnused = options.pruneUnused !== false

  purgeExpiredJobs()

  try {
    await DocumentUpdaterHandler.promises.flushProjectToMongo(key)
  } catch (err) {
    logger.warn({ err, projectId: key }, 'cloud-export: flushProjectToMongo warning')
  }

  const project = await ProjectGetter.promises.getProject(key, {
    name: true,
    rootDoc_id: true,
    compiler: true,
  })
  if (!project) {
    const err = new Error('Project not found')
    err.statusCode = 404
    throw err
  }

  const rawDocs = (await ProjectEntityHandler.promises.getAllDocs(key)) || {}
  const rawFiles = (await ProjectEntityHandler.promises.getAllFiles(key)) || {}
  const { docs: docsMap, files: filesMap } = buildEntityMaps(rawDocs, rawFiles)

  const rootRel = detectRootDocRel(project, docsMap)
  const depResult = pruneUnused
    ? collectTexDependencies(rootRel, docsMap, filesMap)
    : { keptDocs: new Set(docsMap.keys()), keptFiles: new Set(filesMap.keys()) }

  const keptDocs =
    depResult.keptDocs.size > 0 ? depResult.keptDocs : new Set(docsMap.keys())
  const keptFiles = depResult.keptFiles

  const jobId = crypto.randomUUID()
  const jobRoot = path.join(CLOUD_EXPORT_ROOT, jobId)
  const workDir = path.join(jobRoot, 'work')
  const zipPath = path.join(jobRoot, 'cloud-export.zip')
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 })

  let originalBytes = 0
  const droppedFiles = []

  try {
    for (const [rel, doc] of docsMap.entries()) {
      const text = Array.isArray(doc.lines) ? doc.lines.join('\n') : ''
      const bytes = Buffer.byteLength(text, 'utf8')
      originalBytes += bytes
      if (!keptDocs.has(rel)) {
        droppedFiles.push({ relPath: rel, bytes, reason: classifyDroppedReason(rel) })
        continue
      }
      const dest = path.resolve(workDir, rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
      fs.writeFileSync(dest, text, { encoding: 'utf8', mode: 0o644 })
    }

    for (const [rel, file] of filesMap.entries()) {
      if (!file || !file.hash) continue
      const isKept = keptFiles.has(rel)
      try {
        const { stream } =
          await HistoryManager.promises.requestBlobWithProjectId(key, file.hash)
        if (isKept) {
          const dest = path.resolve(workDir, rel)
          fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
          await pipeline(stream, fs.createWriteStream(dest, { mode: 0o644 }))
          const size = fs.statSync(dest).size
          originalBytes += size
        } else {
          let size = 0
          for await (const chunk of stream) {
            size += chunk.length
          }
          originalBytes += size
          droppedFiles.push({
            relPath: rel,
            bytes: size,
            reason: classifyDroppedReason(rel),
          })
        }
      } catch (blobErr) {
        if (isKept) {
          throw blobErr
        }
        logger.warn(
          { err: blobErr, projectId: key, relPath: rel },
          'cloud-export: failed measuring dropped project file blob'
        )
      }
    }

    let optResult = {
      ok: true,
      optimizedFiles: [],
      warning: null,
    }

    if (compressImages) {
      const { stdout } = await execFileAsync(
        'python3',
        [
          OPTIMIZER_SCRIPT,
          '--dir',
          workDir,
          '--target-bytes',
          String(targetBytes),
          '--compress-images',
          'true',
        ],
        { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }
      )
      optResult = JSON.parse(stdout)
    }

    await createZipFromDirectory(workDir, zipPath)
    const cloudBytes = fs.statSync(zipPath).size

    // Remove raw staged work files immediately to minimize disk/RAM usage
    fs.rmSync(workDir, { recursive: true, force: true })

    let warning = optResult.warning || null
    const hardLimitBytes = 30 * 1024 * 1024
    if (cloudBytes > hardLimitBytes) {
      warning = `Cloud ZIP is ${(cloudBytes / (1024 * 1024)).toFixed(1)} MB, above the 30 MB Overleaf limit.`
    }

    const filename = sanitizeZipFilename(project.name)
    activeJobs.set(jobId, {
      jobId,
      projectId: key,
      userId: ownerUserId,
      filename,
      zipPath,
      workDir: jobRoot,
      createdAt: Date.now(),
      expiresAt: Date.now() + JOB_TTL_MS,
    })

    droppedFiles.sort((a, b) => b.bytes - a.bytes)

    return {
      ok: true,
      jobId,
      filename,
      rootDoc: rootRel,
      targetMaxMb,
      originalBytes,
      cloudBytes,
      originalCount: docsMap.size + filesMap.size,
      keptCount: keptDocs.size + keptFiles.size,
      droppedCount: droppedFiles.length,
      droppedFiles,
      compressedFiles: optResult.optimizedFiles || [],
      fitsLimit: cloudBytes <= hardLimitBytes,
      warning,
      downloadUrl: `/project/${key}/download/cloud-zip/${jobId}`,
    }
  } catch (err) {
    try {
      fs.rmSync(jobRoot, { recursive: true, force: true })
    } catch {}
    throw err
  }
}

function consumeCloudZipJob(jobId, projectId, userId) {
  purgeExpiredJobs()
  const job = activeJobs.get(jobId)
  if (!job) return null
  if (job.projectId !== String(projectId) || job.userId !== String(userId)) {
    return null
  }
  if (!fs.existsSync(job.zipPath)) {
    activeJobs.delete(jobId)
    cleanupJobFiles(job)
    return null
  }
  activeJobs.delete(jobId)
  return job
}

const ProjectCloudExportManager = {
  createCloudZipJob,
  consumeCloudZipJob,
  cleanupJobFiles,
  collectTexDependencies,
  stripTexComments,
}

export default ProjectCloudExportManager
