import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import { Project } from '../../models/Project.mjs'
import { User } from '../../models/User.mjs'
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs'
import EditorController from '../Editor/EditorController.mjs'
import HistoryManager from '../History/HistoryManager.mjs'
import ProjectEntityHandler from './ProjectEntityHandler.mjs'
import ProjectGetter from './ProjectGetter.mjs'
import ProjectHelper from './ProjectHelper.mjs'
import {
  ALLOWED_ROOT,
  DEFAULT_BASE_DIR,
  SYNC_MANIFEST_FILENAME,
  doPathsOverlap,
  sanitizeProjectFolderName,
  validateHostFolderPath,
  validateRelativeEntityPath,
} from './LocalProjectSyncPathUtils.mjs'

const SOCKET_PATH =
  process.env.LOCAL_SYNC_SOCKET_PATH || '/run/overleaf-local-sync/sync.sock'
const STAGE_ROOT = path.resolve(
  process.env.LOCAL_SYNC_STAGE_ROOT || '/tmp/overleaf-local-sync-stage'
)
const DEBOUNCE_MS = 1200
const WATCH_SUPPRESS_MS = 2500

/** @type {Map<string, { timer: NodeJS.Timeout, options: Record<string, any> }>} */
const pendingSyncs = new Map()

/** @type {Set<string>} Projects currently undergoing ingest from host */
const activeIngests = new Set()

/** @type {Set<string>} Projects currently exporting to host */
const activeExports = new Set()

/** @type {Map<string, number>} Suppress self-echo fs.watch bursts until timestamp */
const suppressWatcherUntil = new Map()

/** @type {Map<string, Promise<any>>} Per-project sync mutex */
const projectSyncLocks = new Map()

/** @type {Map<string, { watcher: fs.FSWatcher, targetDir: string, projectName: string }>} */
const activeWatchers = new Map()

async function withProjectSyncLock(key, fn) {
  const prev = projectSyncLocks.get(key) || Promise.resolve()
  let release
  const current = new Promise(resolve => {
    release = resolve
  })
  const chained = prev.then(() => current)
  projectSyncLocks.set(key, chained)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (projectSyncLocks.get(key) === chained) {
      projectSyncLocks.delete(key)
    }
  }
}

function toRelPath(rawPath) {
  return String(rawPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
}

function buildEntityLookup(entityMap) {
  const lookup = new Map()
  for (const [rawKey, value] of Object.entries(entityMap || {})) {
    const rel = toRelPath(rawKey)
    if (rel) {
      lookup.set(rel, value)
    }
  }
  return lookup
}

function normalizeDocText(text) {
  return String(text || '').replace(/\r\n|\r/g, '\n')
}

function sha1Raw(input) {
  return crypto.createHash('sha1').update(input).digest('hex')
}

function sha1GitBlob(buf) {
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf8')
  return crypto.createHash('sha1').update(header).update(buf).digest('hex')
}

function sha1FileStream(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1')
    const stream = fs.createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function readSyncManifest(targetDir) {
  const manifestPath = path.join(targetDir, SYNC_MANIFEST_FILENAME)
  try {
    const st = fs.lstatSync(manifestPath)
    if (!st.isFile() || st.isSymbolicLink()) return null
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const files = new Set(
      Array.isArray(parsed.files) ? parsed.files.map(toRelPath).filter(Boolean) : []
    )
    const baselines =
      parsed.baselines && typeof parsed.baselines === 'object' ? parsed.baselines : null
    return { raw: parsed, files, baselines }
  } catch {
    return null
  }
}

function computeHostFileHashInfo(hostFile) {
  try {
    if (hostFile.isDoc) {
      const rawContent = fs.readFileSync(hostFile.absPath, 'utf8')
      const normalized = normalizeDocText(rawContent)
      return {
        rawContent,
        hostSha1: sha1Raw(Buffer.from(normalized, 'utf8')),
        hostGitHash: null,
      }
    }
    const buf = fs.readFileSync(hostFile.absPath)
    return {
      rawContent: null,
      hostSha1: sha1Raw(buf),
      hostGitHash: sha1GitBlob(buf),
    }
  } catch {
    return null
  }
}

function shouldIngestEntry({
  presentInOverleaf,
  sameContent,
  hasBaseline,
  hostChanged,
  ovChanged,
  inManifest,
  hostMtimeMs,
  ovUpdatedMs,
  lastSyncMs,
  hostTriggered,
  preferHost,
}) {
  if (!presentInOverleaf) {
    if (inManifest && hasBaseline && !hostChanged) {
      return false
    }
    return true
  }
  if (sameContent) {
    return false
  }
  if (hasBaseline) {
    if (!hostChanged) {
      return false
    }
    if (!ovChanged || preferHost) {
      return true
    }
    if (!hostTriggered && hostMtimeMs + 1000 < ovUpdatedMs) {
      return false
    }
    return hostMtimeMs >= ovUpdatedMs
  }
  if (preferHost) {
    return true
  }
  return (
    hostMtimeMs > lastSyncMs + 1000 &&
    (Boolean(hostTriggered) || ovUpdatedMs <= lastSyncMs + 1000)
  )
}

/**
 * Text file extensions that should be treated as Overleaf Docs (UTF-8 lines)
 */
const TEXT_EXTS = new Set([
  '.tex',
  '.bib',
  '.cls',
  '.sty',
  '.bst',
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.tsv',
  '.yaml',
  '.yml',
  '.xml',
  '.html',
  '.css',
  '.js',
  '.mjs',
  '.py',
  '.sh',
  '.r',
  '.lua',
  '.tikz',
  '.dtx',
  '.ins',
])

/**
 * Extensions to ignore completely during directory scan
 */
const IGNORE_EXTS = new Set([
  '.aux',
  '.log',
  '.out',
  '.bbl',
  '.blg',
  '.synctex',
  '.synctex.gz',
  '.toc',
  '.lof',
  '.lot',
  '.fls',
  '.fdb_latexmk',
  '.nav',
  '.snm',
  '.vrb',
  '.run.xml',
  '-blx.bib',
  '.bak',
  '.swp',
  '.swo',
])

function isDocExtension(filename) {
  const ext = path.extname(filename).toLowerCase()
  return TEXT_EXTS.has(ext)
}

function shouldIgnoreHostFile(relPath, projectName, projectId) {
  const normalized = relPath.replace(/\\/g, '/')
  const segments = normalized.split('/')
  const baseName = segments[segments.length - 1]

  // Ignore hidden files and directories
  for (const seg of segments) {
    if (seg.startsWith('.') && seg !== '.') return true
  }

  // Ignore temp and backup files
  if (baseName.startsWith('~') || baseName.endsWith('.tmp')) return true
  if (baseName.includes('.overleaf-tmp-')) return true

  // Ignore sync manifest
  if (baseName === SYNC_MANIFEST_FILENAME) return true

  // Ignore version control directories
  if (segments.some(s => s === '.git' || s === '.svn' || s === '.hg')) {
    return true
  }

  // Ignore build artifacts
  const ext = path.extname(baseName).toLowerCase()
  if (IGNORE_EXTS.has(ext)) return true

  // Ignore root-level compiled PDF (e.g. output.pdf, main.pdf, <projectName>.pdf)
  // but preserve any PDF assets inside subdirectories (e.g. figures/*.pdf)
  if (segments.length === 1 && ext === '.pdf') {
    const sanitized = sanitizeProjectFolderName(projectName, projectId)
    const lower = baseName.toLowerCase()
    if (
      lower === 'output.pdf' ||
      lower === 'main.pdf' ||
      lower === `${sanitized.toLowerCase()}.pdf` ||
      lower === `${(projectName || '').toLowerCase()}.pdf`
    ) {
      return true
    }
  }

  return false
}

/**
 * Scan target directory on host recursively for legitimate source files.
 * @param {string} targetDir
 * @param {string} projectName
 * @param {string} projectId
 * @returns {Array<{ relPath: string, absPath: string, size: number, mtimeMs: number, isDoc: boolean }>}
 */
function scanHostDirectory(targetDir, projectName, projectId) {
  const results = []

  function walk(currentDir) {
    let entries = []
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      const relPath = path.relative(targetDir, fullPath).replace(/\\/g, '/')

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        walk(fullPath)
      } else if (entry.isFile()) {
        if (shouldIgnoreHostFile(relPath, projectName, projectId)) continue
        const v = validateRelativeEntityPath(relPath)
        if (!v.ok) continue

        try {
          const st = fs.statSync(fullPath)
          results.push({
            relPath: v.relPath,
            absPath: fullPath,
            size: st.size,
            mtimeMs: st.mtimeMs,
            isDoc: isDocExtension(entry.name),
          })
        } catch {}
      }
    }
  }

  walk(targetDir)
  return results
}

/**
 * Call the uid=1000 local-sync daemon over its internal Unix domain socket.
 */
function callDaemon(method, endpoint, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null
    const headers = {}
    if (payload != null) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }

    const req = http.request(
      {
        socketPath: SOCKET_PATH,
        path: endpoint,
        method,
        headers,
        timeout: timeoutMs,
      },
      res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let parsed = null
          try {
            parsed = raw ? JSON.parse(raw) : {}
          } catch {
            parsed = { ok: false, error: raw || 'Invalid daemon response' }
          }
          resolve({ statusCode: res.statusCode || 500, data: parsed })
        })
      }
    )

    req.on('timeout', () => {
      req.destroy(new Error('Local sync service timed out'))
    })
    req.on('error', err => {
      reject(
        new Error(
          `Local folder sync service is unavailable (${err?.code || err?.message})`
        )
      )
    })

    if (payload != null) {
      req.write(payload)
    }
    req.end()
  })
}

async function getUserBaseDir(userId) {
  if (!userId) return DEFAULT_BASE_DIR
  const user = await User.findById(userId, { localSyncBaseDir: 1 }).lean()
  if (user?.localSyncBaseDir && typeof user.localSyncBaseDir === 'string') {
    const check = validateHostFolderPath(user.localSyncBaseDir, {
      checkSymlinks: false,
    })
    if (check.ok) {
      return check.normalizedPath
    }
  }
  return DEFAULT_BASE_DIR
}

function resolveFolderPathsForProjects(baseDir, projects) {
  const result = new Map()
  const usedPaths = new Set()

  for (const project of projects) {
    const id = String(project._id || project.id)
    if (project.localFolderPath && typeof project.localFolderPath === 'string') {
      const check = validateHostFolderPath(project.localFolderPath, {
        checkSymlinks: false,
      })
      if (check.ok) {
        result.set(id, { effectivePath: check.normalizedPath, isCustom: true })
        usedPaths.add(check.normalizedPath.toLowerCase())
      }
    }
  }

  const defaultProjects = projects
    .filter(p => !result.has(String(p._id || p.id)))
    .sort((a, b) => String(a._id || a.id).localeCompare(String(b._id || b.id)))

  for (const project of defaultProjects) {
    const id = String(project._id || project.id)
    const folderName = sanitizeProjectFolderName(project.name, id)
    let candidate = path.join(baseDir, folderName)
    if (usedPaths.has(candidate.toLowerCase())) {
      candidate = path.join(baseDir, `${folderName} (${id.slice(-6)})`)
    }
    usedPaths.add(candidate.toLowerCase())
    result.set(id, { effectivePath: candidate, isCustom: false })
  }

  return result
}

async function getResolvedProjectFolder(project, ownerBaseDir = null) {
  const projectId = String(project._id || project.id)
  const ownerId = project.owner_ref ? String(project.owner_ref) : null
  const baseDir = ownerBaseDir || (await getUserBaseDir(ownerId))

  if (project.localFolderPath && typeof project.localFolderPath === 'string') {
    const check = validateHostFolderPath(project.localFolderPath, {
      checkSymlinks: false,
    })
    if (check.ok) {
      return { effectivePath: check.normalizedPath, isCustom: true, baseDir }
    }
  }

  const siblingProjects = ownerId
    ? await Project.find(
        { owner_ref: ownerId },
        { _id: 1, name: 1, localFolderPath: 1 }
      ).lean()
    : [project]

  const map = resolveFolderPathsForProjects(baseDir, siblingProjects)
  const resolved = map.get(projectId)
  if (resolved) {
    return { ...resolved, baseDir }
  }
  return {
    effectivePath: path.join(
      baseDir,
      sanitizeProjectFolderName(project.name, projectId)
    ),
    isCustom: false,
    baseDir,
  }
}

async function buildProjectFolderInfoMap(userId, rawProjects) {
  const userBaseDir = await getUserBaseDir(userId)

  const ownerBaseDirs = new Map([[String(userId), userBaseDir]])
  const otherOwnerIds = new Set()
  for (const p of rawProjects) {
    if (p.owner_ref && String(p.owner_ref) !== String(userId)) {
      otherOwnerIds.add(String(p.owner_ref))
    }
  }
  if (otherOwnerIds.size > 0) {
    const owners = await User.find(
      { _id: { $in: Array.from(otherOwnerIds) } },
      { _id: 1, localSyncBaseDir: 1 }
    ).lean()
    for (const o of owners) {
      const check =
        o.localSyncBaseDir &&
        validateHostFolderPath(o.localSyncBaseDir, { checkSymlinks: false })
      ownerBaseDirs.set(
        String(o._id),
        check && check.ok ? check.normalizedPath : DEFAULT_BASE_DIR
      )
    }
  }

  /** @type {Map<string, Array<any>>} */
  const byOwner = new Map()
  for (const p of rawProjects) {
    const ownerKey = String(p.owner_ref || userId)
    if (!byOwner.has(ownerKey)) byOwner.set(ownerKey, [])
    byOwner.get(ownerKey).push(p)
  }

  const resolvedAll = new Map()
  for (const [ownerKey, projects] of byOwner.entries()) {
    const baseDir = ownerBaseDirs.get(ownerKey) || DEFAULT_BASE_DIR
    const ownerMap = resolveFolderPathsForProjects(baseDir, projects)
    for (const [id, info] of ownerMap.entries()) {
      resolvedAll.set(id, { ...info, baseDir })
    }
  }

  const infoMap = new Map()
  for (const p of rawProjects) {
    const id = String(p._id || p.id)
    const resolved = resolvedAll.get(id) || {
      effectivePath: path.join(
        userBaseDir,
        sanitizeProjectFolderName(p.name, id)
      ),
      isCustom: false,
      baseDir: userBaseDir,
    }
    const syncEnabled = p.localFolderSyncEnabled !== false
    infoMap.set(id, {
      customPath: p.localFolderPath || null,
      effectivePath: resolved.effectivePath,
      isCustom: resolved.isCustom,
      syncEnabled,
      lastSyncedAt: p.localFolderLastSyncedAt
        ? new Date(p.localFolderLastSyncedAt).toISOString()
        : null,
      lastSyncedPath: p.localFolderLastSyncedPath || null,
      status: !syncEnabled
        ? 'disabled'
        : p.localFolderLastSyncStatus || 'not_synced',
      error: p.localFolderLastSyncError || null,
      fileCount:
        typeof p.localFolderFileCount === 'number'
          ? p.localFolderFileCount
          : null,
      hasPdf: Boolean(p.localFolderHasPdf),
    })
  }
  return infoMap
}

function findLatestCompiledPdf(projectId, preferredBuild = null) {
  const outputBase = Settings?.path?.outputDir || '/var/lib/overleaf/data/output'
  const compilesBase =
    Settings?.path?.compilesDir || '/var/lib/overleaf/data/compiles'

  const candidates = []

  if (preferredBuild?.buildId) {
    const dirsToTry = []
    if (preferredBuild.userId) {
      dirsToTry.push(
        path.join(
          outputBase,
          `${projectId}-${preferredBuild.userId}`,
          'generated-files',
          preferredBuild.buildId,
          'output.pdf'
        )
      )
    }
    dirsToTry.push(
      path.join(
        outputBase,
        String(projectId),
        'generated-files',
        preferredBuild.buildId,
        'output.pdf'
      )
    )
    for (const p of dirsToTry) {
      try {
        const st = fs.statSync(p)
        if (st.isFile() && st.size > 0) {
          return p
        }
      } catch {}
    }
  }

  try {
    const entries = fs.readdirSync(outputBase, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (
        entry.name !== String(projectId) &&
        !entry.name.startsWith(`${projectId}-`)
      ) {
        continue
      }
      const genDir = path.join(outputBase, entry.name, 'generated-files')
      try {
        const builds = fs.readdirSync(genDir, { withFileTypes: true })
        for (const b of builds) {
          if (!b.isDirectory()) continue
          const pdfPath = path.join(genDir, b.name, 'output.pdf')
          try {
            const st = fs.statSync(pdfPath)
            if (st.isFile() && st.size > 0) {
              candidates.push({ path: pdfPath, mtimeMs: st.mtimeMs })
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}

  if (candidates.length === 0) {
    try {
      const entries = fs.readdirSync(compilesBase, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (
          entry.name !== String(projectId) &&
          !entry.name.startsWith(`${projectId}-`)
        ) {
          continue
        }
        const pdfPath = path.join(compilesBase, entry.name, 'output.pdf')
        try {
          const st = fs.statSync(pdfPath)
          if (st.isFile() && st.size > 0) {
            candidates.push({ path: pdfPath, mtimeMs: st.mtimeMs })
          }
        } catch {}
      }
    } catch {}
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0].path
}

/**
 * Ingest new or modified files from host targetDir into Overleaf database/storage.
 * Uses per-file 3-way baselines from .overleaf-sync.json so live Overleaf edits are never
 * overwritten by stale host files while direct host modifications ingest cleanly.
 * @param {string} projectId
 * @param {{ userId?: string, force?: boolean, hostTriggered?: boolean, preferHost?: boolean, updateManifest?: boolean }} [options]
 */
async function syncFromLocalFolder(projectId, options = {}) {
  const key = String(projectId)
  activeIngests.add(key)

  try {
    const project = await ProjectGetter.promises.getProject(projectId, {
      _id: 1,
      name: 1,
      owner_ref: 1,
      trashed: 1,
      lastUpdated: 1,
      localFolderPath: 1,
      localFolderSyncEnabled: 1,
      localFolderLastSyncedPath: 1,
      localFolderLastSyncedAt: 1,
      rootFolder: 1,
    })

    if (!project) {
      return { ok: false, skipped: true, reason: 'project_not_found' }
    }

    const ownerId = project.owner_ref ? String(project.owner_ref) : null
    const effectiveUserId = options.userId || ownerId

    const { effectivePath: targetDir, isCustom } =
      await getResolvedProjectFolder(project)

    if (!fs.existsSync(targetDir)) {
      return { ok: false, skipped: true, reason: 'target_dir_not_found', targetDir }
    }

    // 1. Flush any pending in-memory edits before reading Overleaf docs
    try {
      await DocumentUpdaterHandler.promises.flushProjectToMongo(key)
    } catch (flushErr) {
      logger.warn(
        { err: flushErr, projectId: key },
        'local-sync: non-fatal error flushing project before host ingest'
      )
    }

    // 2. Scan host directory and read existing sync manifest baselines
    const hostFiles = scanHostDirectory(targetDir, project.name, key)
    const manifest = readSyncManifest(targetDir)
    const manifestFiles = manifest?.files || new Set()
    const baselines = manifest?.baselines || {}
    const lastSyncMs = project.localFolderLastSyncedAt
      ? new Date(project.localFolderLastSyncedAt).getTime()
      : 0
    const ovUpdatedMs = project.lastUpdated
      ? new Date(project.lastUpdated).getTime()
      : 0

    // 3. Get existing Overleaf docs and files with normalized relative keys (no leading '/')
    const docsByRel = buildEntityLookup(
      (await ProjectEntityHandler.promises.getAllDocs(key)) || {}
    )
    const filesByRel = buildEntityLookup(
      (await ProjectEntityHandler.promises.getAllFiles(key)) || {}
    )

    const addedDocs = []
    const updatedDocs = []
    const addedFiles = []
    const updatedFiles = []

    // 4. Ingest only host files that genuinely changed on disk without clobbering Overleaf edits
    for (const hostFile of hostFiles) {
      const relPath = hostFile.relPath
      const elementPath = `/${relPath}`
      const base = baselines[relPath] || null
      const hashInfo = computeHostFileHashInfo(hostFile)
      if (!hashInfo) continue

      if (hostFile.isDoc) {
        const existingDoc = docsByRel.get(relPath) || null
        const currentContent = existingDoc
          ? normalizeDocText(Array.isArray(existingDoc.lines) ? existingDoc.lines.join('\n') : '')
          : null
        const ovHash =
          currentContent !== null ? sha1Raw(Buffer.from(currentContent, 'utf8')) : null
        const sameContent = ovHash !== null && ovHash === hashInfo.hostSha1
        const hostChanged = base ? hashInfo.hostSha1 !== base.hostSha1 : true
        const ovChanged = Boolean(base && ovHash !== null && ovHash !== base.overleafHash)

        const ingest = shouldIngestEntry({
          presentInOverleaf: Boolean(existingDoc),
          sameContent,
          hasBaseline: Boolean(base),
          hostChanged,
          ovChanged,
          inManifest: manifestFiles.has(relPath),
          hostMtimeMs: hostFile.mtimeMs,
          ovUpdatedMs,
          lastSyncMs,
          hostTriggered: options.hostTriggered,
          preferHost: options.preferHost,
        })

        if (!ingest) continue

        const lines = hashInfo.rawContent.split(/\r\n|\n|\r/)
        try {
          await EditorController.promises.upsertDocWithPath(
            key,
            elementPath,
            lines,
            'local-sync',
            effectiveUserId
          )
          if (existingDoc) {
            updatedDocs.push(relPath)
          } else {
            addedDocs.push(relPath)
          }
        } catch (err) {
          logger.warn(
            { err, relPath, projectId: key },
            `local-sync: failed ${existingDoc ? 'updating' : 'adding'} doc from host`
          )
        }
      } else {
        const existingFile = filesByRel.get(relPath) || null
        const ovHash = existingFile?.hash || null
        const sameContent = ovHash !== null && ovHash === hashInfo.hostGitHash
        const hostChanged = base ? hashInfo.hostSha1 !== base.hostSha1 : true
        const ovChanged = Boolean(base && ovHash !== null && ovHash !== base.overleafHash)

        const ingest = shouldIngestEntry({
          presentInOverleaf: Boolean(existingFile),
          sameContent,
          hasBaseline: Boolean(base),
          hostChanged,
          ovChanged,
          inManifest: manifestFiles.has(relPath),
          hostMtimeMs: hostFile.mtimeMs,
          ovUpdatedMs,
          lastSyncMs,
          hostTriggered: options.hostTriggered,
          preferHost: options.preferHost,
        })

        if (!ingest) continue

        try {
          await EditorController.promises.upsertFileWithPath(
            key,
            elementPath,
            hostFile.absPath,
            null,
            'local-sync',
            effectiveUserId
          )
          if (existingFile) {
            updatedFiles.push(relPath)
          } else {
            addedFiles.push(relPath)
          }
        } catch (err) {
          logger.warn(
            { err, relPath, projectId: key },
            `local-sync: failed ${existingFile ? 'updating' : 'adding'} binary file from host`
          )
        }
      }
    }

    const refreshedDocs = buildEntityLookup(
      (await ProjectEntityHandler.promises.getAllDocs(key)) || {}
    )
    const refreshedFiles = buildEntityLookup(
      (await ProjectEntityHandler.promises.getAllFiles(key)) || {}
    )

    const allCurrentRelPaths = new Set([
      ...refreshedDocs.keys(),
      ...refreshedFiles.keys(),
    ])
    const totalFilesCount = allCurrentRelPaths.size
    const syncedAtDate = new Date()

    if (options.updateManifest !== false) {
      const nextBaselines = {}
      for (const [relPath, doc] of refreshedDocs.entries()) {
        const content = Array.isArray(doc.lines) ? doc.lines.join('\n') : ''
        nextBaselines[relPath] = {
          hostSha1: sha1Raw(Buffer.from(normalizeDocText(content), 'utf8')),
          overleafHash: sha1Raw(Buffer.from(content, 'utf8')),
          kind: 'doc',
        }
      }
      for (const [relPath, file] of refreshedFiles.entries()) {
        const hf = hostFiles.find(h => h.relPath === relPath && !h.isDoc)
        const base = baselines[relPath]
        nextBaselines[relPath] = {
          hostSha1: base?.hostSha1 || (hf ? computeHostFileHashInfo(hf)?.hostSha1 : null),
          overleafHash: file?.hash || base?.overleafHash || null,
          kind: 'file',
        }
      }
      suppressWatcherUntil.set(key, Date.now() + WATCH_SUPPRESS_MS)
      try {
        await callDaemon('POST', '/manifest', {
          projectId: key,
          projectName: project.name,
          targetDir,
          files: Array.from(allCurrentRelPaths).sort(),
          baselines: nextBaselines,
        })
      } catch {}
    }

    await Project.updateOne(
      { _id: key },
      {
        $set: {
          localFolderLastSyncedAt: syncedAtDate,
          localFolderLastSyncStatus: 'synced',
          localFolderLastSyncError: null,
          localFolderLastSyncedPath: targetDir,
          localFolderFileCount: totalFilesCount,
        },
      }
    ).exec()

    logger.info(
      {
        projectId: key,
        targetDir,
        addedDocsCount: addedDocs.length,
        updatedDocsCount: updatedDocs.length,
        addedFilesCount: addedFiles.length,
        updatedFilesCount: updatedFiles.length,
        totalFilesCount,
      },
      'local-sync: host ingest check finished'
    )

    return {
      ok: true,
      projectId: key,
      targetDir,
      isCustom,
      addedDocs,
      updatedDocs,
      addedFiles,
      updatedFiles,
      totalFilesCount,
      syncedAt: syncedAtDate.toISOString(),
    }
  } finally {
    // Clear any sync scheduled during our own ingest unless an export step follows
    if (options.updateManifest !== false) {
      const existing = pendingSyncs.get(key)
      if (existing?.timer) {
        clearTimeout(existing.timer)
      }
      pendingSyncs.delete(key)
    }
    activeIngests.delete(key)
  }
}

/**
 * Sync a project between Overleaf and its local host folder.
 * Serialized per project to prevent concurrent read/write races.
 */
async function syncProject(projectId, options = {}) {
  const key = String(projectId)
  return await withProjectSyncLock(key, () => syncProjectUnlocked(key, options))
}

async function syncProjectUnlocked(key, options = {}) {
  const {
    force = false,
    oldDir = null,
    cleanOld = false,
    compiledPdf = null,
    direction = 'overleaf-to-host',
    hostTriggered = false,
    preferHost = false,
    userId = null,
  } = options

  const project = await ProjectGetter.promises.getProject(key, {
    _id: 1,
    name: 1,
    owner_ref: 1,
    trashed: 1,
    localFolderPath: 1,
    localFolderSyncEnabled: 1,
    localFolderLastSyncedPath: 1,
  })

  if (!project) {
    return { ok: false, skipped: true, reason: 'project_not_found' }
  }

  const ownerId = project.owner_ref ? String(project.owner_ref) : null
  if (!force && ownerId && ProjectHelper.isTrashed(project, ownerId)) {
    return { ok: false, skipped: true, reason: 'project_trashed' }
  }

  if (!force && project.localFolderSyncEnabled === false) {
    return { ok: false, skipped: true, reason: 'sync_disabled' }
  }

  const { effectivePath: targetDir, isCustom } =
    await getResolvedProjectFolder(project)

  watchProjectFolder(key, targetDir, userId || ownerId, project.name)

  // Step 1: Only ingest from host when direction includes host-to-overleaf
  let ingestResult = null
  if (direction === 'bidirectional' || direction === 'host-to-overleaf') {
    if (fs.existsSync(targetDir)) {
      ingestResult = await syncFromLocalFolder(key, {
        userId,
        force,
        hostTriggered,
        preferHost,
        updateManifest: direction === 'host-to-overleaf',
      })
    }
  }

  if (direction === 'host-to-overleaf') {
    return ingestResult || { ok: true, targetDir, isCustom }
  }

  // Step 2: Overleaf to host staging and atomic export
  const jobId = `${key}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const stagingDir = path.join(STAGE_ROOT, jobId)
  activeExports.add(key)

  try {
    try {
      await DocumentUpdaterHandler.promises.flushProjectToMongo(key)
    } catch {}

    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o755 })

    const stagedRelFiles = []
    const stagedSet = new Set()
    const baselines = {}

    const docs = await ProjectEntityHandler.promises.getAllDocs(key)
    for (const [rawDocPath, doc] of Object.entries(docs || {})) {
      const v = validateRelativeEntityPath(rawDocPath)
      if (!v.ok) continue
      const dest = path.resolve(stagingDir, v.relPath)
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 })
      const content = Array.isArray(doc.lines) ? doc.lines.join('\n') : ''
      fs.writeFileSync(dest, content, { encoding: 'utf8', mode: 0o644 })
      if (!stagedSet.has(v.relPath)) {
        stagedSet.add(v.relPath)
        stagedRelFiles.push(v.relPath)
      }
      baselines[v.relPath] = {
        hostSha1: sha1Raw(Buffer.from(normalizeDocText(content), 'utf8')),
        overleafHash: sha1Raw(Buffer.from(content, 'utf8')),
        kind: 'doc',
      }
    }

    const files = await ProjectEntityHandler.promises.getAllFiles(key)
    for (const [rawFilePath, file] of Object.entries(files || {})) {
      if (!file || !file.hash) continue
      const v = validateRelativeEntityPath(rawFilePath)
      if (!v.ok) continue
      const dest = path.resolve(stagingDir, v.relPath)
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 })
      try {
        const { stream } =
          await HistoryManager.promises.requestBlobWithProjectId(key, file.hash)
        await pipeline(stream, fs.createWriteStream(dest, { mode: 0o644 }))
        const hostSha1 = await sha1FileStream(dest)
        if (!stagedSet.has(v.relPath)) {
          stagedSet.add(v.relPath)
          stagedRelFiles.push(v.relPath)
        }
        baselines[v.relPath] = {
          hostSha1,
          overleafHash: file.hash,
          kind: 'file',
        }
      } catch (blobErr) {
        logger.warn(
          { err: blobErr, projectId: key, filePath: v.relPath, hash: file.hash },
          'local-sync: failed fetching binary file blob'
        )
      }
    }

    let hasPdf = false
    const pdfSourcePath = findLatestCompiledPdf(key, compiledPdf)
    if (pdfSourcePath) {
      let pdfName = `${sanitizeProjectFolderName(project.name, key)}.pdf`
      if (stagedSet.has(pdfName)) {
        pdfName = stagedSet.has('output.pdf')
          ? '_overleaf_compiled_output.pdf'
          : 'output.pdf'
      }
      const destPdf = path.resolve(stagingDir, pdfName)
      try {
        fs.copyFileSync(pdfSourcePath, destPdf)
        fs.chmodSync(destPdf, 0o644)
        stagedSet.add(pdfName)
        stagedRelFiles.push(pdfName)
        hasPdf = true
      } catch {}
    }

    const effectiveOldDir =
      oldDir ||
      (cleanOld &&
      project.localFolderLastSyncedPath &&
      project.localFolderLastSyncedPath !== targetDir
        ? project.localFolderLastSyncedPath
        : null)

    suppressWatcherUntil.set(key, Date.now() + WATCH_SUPPRESS_MS)

    const { statusCode, data } = await callDaemon('POST', '/sync', {
      projectId: key,
      projectName: project.name,
      targetDir,
      stagingDir,
      files: stagedRelFiles,
      baselines,
      oldDir: effectiveOldDir,
      cleanOld: Boolean(cleanOld && effectiveOldDir),
    })

    if (statusCode !== 200 || !data?.ok) {
      const errorMsg = data?.error || `Sync failed (HTTP ${statusCode})`
      await Project.updateOne(
        { _id: key },
        {
          $set: {
            localFolderLastSyncStatus: 'error',
            localFolderLastSyncError: errorMsg,
          },
        }
      ).exec()
      return {
        ok: false,
        error: errorMsg,
        targetDir,
        isCustom,
      }
    }

    const syncedAtDate = new Date(data.syncedAt || Date.now())
    await Project.updateOne(
      { _id: key },
      {
        $set: {
          localFolderLastSyncedAt: syncedAtDate,
          localFolderLastSyncStatus: 'synced',
          localFolderLastSyncError: null,
          localFolderLastSyncedPath: data.targetDir,
          localFolderFileCount: data.syncedFilesCount,
          localFolderHasPdf: hasPdf,
        },
      }
    ).exec()

    return {
      ok: true,
      projectId: key,
      projectName: project.name,
      targetDir: data.targetDir,
      isCustom,
      syncedFilesCount: data.syncedFilesCount,
      removedStaleCount: data.removedStaleCount,
      cleanedOldDir: data.cleanedOldDir,
      hasPdf,
      ingestResult,
      syncedAt: syncedAtDate.toISOString(),
    }
  } catch (err) {
    const errorMsg = err?.message || 'Unexpected error during local folder sync'
    logger.error({ err, projectId: key, targetDir }, 'local-sync: syncProject failed')
    try {
      await Project.updateOne(
        { _id: key },
        {
          $set: {
            localFolderLastSyncStatus: 'error',
            localFolderLastSyncError: errorMsg,
          },
        }
      ).exec()
    } catch {}
    return { ok: false, error: errorMsg, targetDir, isCustom }
  } finally {
    suppressWatcherUntil.set(key, Date.now() + WATCH_SUPPRESS_MS)
    activeExports.delete(key)
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true })
    } catch {}
  }
}

/**
 * Determine whether any file on host disk actually differs from its last synced baseline
 * (or was newly added on host). Shared by both loadEditor check and fs.watch debounce.
 */
async function detectHostChanges(projectId, targetDir, projectName, lastSyncMs = 0) {
  const key = String(projectId)
  if (!fs.existsSync(targetDir)) {
    return { hostChanged: false, needsExport: false }
  }

  const hostFiles = scanHostDirectory(targetDir, projectName, key)
  const manifest = readSyncManifest(targetDir)
  const baselines = manifest?.baselines || null
  const manifestFiles = manifest?.files || new Set()

  const docsByRel = buildEntityLookup(
    (await ProjectEntityHandler.promises.getAllDocs(key)) || {}
  )
  const filesByRel = buildEntityLookup(
    (await ProjectEntityHandler.promises.getAllFiles(key)) || {}
  )

  for (const hf of hostFiles) {
    const relPath = hf.relPath
    const base = baselines?.[relPath] || null
    if (base && base.hostSha1) {
      if (
        Math.abs(hf.mtimeMs - Number(base.mtimeMs || 0)) < 1 &&
        hf.size === Number(base.size ?? -1)
      ) {
        continue
      }
      const hashInfo = computeHostFileHashInfo(hf)
      if (hashInfo && hashInfo.hostSha1 !== base.hostSha1) {
        return { hostChanged: true, reason: 'baseline_mismatch', relPath }
      }
      continue
    }

    const existingDoc = hf.isDoc ? docsByRel.get(relPath) : null
    const existingFile = !hf.isDoc ? filesByRel.get(relPath) : null
    const isTracked = Boolean(existingDoc || existingFile)
    if (!isTracked) {
      if (!manifestFiles.has(relPath) || hf.mtimeMs > lastSyncMs + 1000) {
        return { hostChanged: true, reason: 'new_host_file', relPath }
      }
      continue
    }

    if (hf.mtimeMs > lastSyncMs + 1000) {
      const hashInfo = computeHostFileHashInfo(hf)
      if (!hashInfo) continue
      if (existingDoc) {
        const currentText = normalizeDocText(
          Array.isArray(existingDoc.lines) ? existingDoc.lines.join('\n') : ''
        )
        const ovSha1 = sha1Raw(Buffer.from(currentText, 'utf8'))
        if (ovSha1 !== hashInfo.hostSha1) {
          return { hostChanged: true, reason: 'legacy_doc_modified', relPath }
        }
      } else if (existingFile && existingFile.hash !== hashInfo.hostGitHash) {
        return { hostChanged: true, reason: 'legacy_file_modified', relPath }
      }
    }
  }

  let needsExport = !manifest || !baselines
  if (!needsExport && baselines) {
    for (const [relPath, doc] of docsByRel.entries()) {
      const content = Array.isArray(doc.lines) ? doc.lines.join('\n') : ''
      const ovSha1 = sha1Raw(Buffer.from(content, 'utf8'))
      if (!baselines[relPath] || baselines[relPath].overleafHash !== ovSha1) {
        needsExport = true
        break
      }
    }
  }
  if (!needsExport && baselines) {
    for (const [relPath, file] of filesByRel.entries()) {
      if (!baselines[relPath] || baselines[relPath].overleafHash !== file?.hash) {
        needsExport = true
        break
      }
    }
  }

  return { hostChanged: false, needsExport }
}

/**
 * Check if the host folder has genuine content changes that need to be ingested into Overleaf.
 * Called when an editor session is loaded (/project/:Project_id).
 * Never overwrites live Overleaf edits when the host folder did not change.
 */
async function syncFromLocalFolderIfChanged(projectId, options = {}) {
  const key = String(projectId)
  if (activeIngests.has(key) || activeExports.has(key)) {
    return { changed: false }
  }
  try {
    const project = await ProjectGetter.promises.getProject(key, {
      _id: 1,
      name: 1,
      owner_ref: 1,
      trashed: 1,
      localFolderPath: 1,
      localFolderSyncEnabled: 1,
      localFolderLastSyncedAt: 1,
    })

    if (!project || project.localFolderSyncEnabled === false) {
      return { changed: false }
    }

    const { effectivePath: targetDir } = await getResolvedProjectFolder(project)
    if (!fs.existsSync(targetDir)) {
      return { changed: false }
    }

    watchProjectFolder(key, targetDir, options.userId || project.owner_ref, project.name)

    const lastSyncMs = project.localFolderLastSyncedAt
      ? new Date(project.localFolderLastSyncedAt).getTime()
      : 0

    const detection = await detectHostChanges(key, targetDir, project.name, lastSyncMs)

    if (detection.hostChanged) {
      logger.info(
        { projectId: key, targetDir, reason: detection.reason, relPath: detection.relPath },
        'local-sync: detected genuine host folder edit on load, syncing into Overleaf'
      )
      const result = await syncProject(key, {
        direction: 'bidirectional',
        hostTriggered: true,
        userId: options.userId,
        force: true,
      })
      return { changed: true, result }
    }

    if (detection.needsExport) {
      scheduleSync(key, { direction: 'overleaf-to-host', userId: options.userId })
    }

    return { changed: false }
  } catch (err) {
    logger.warn({ err, projectId: key }, 'local-sync: error during syncFromLocalFolderIfChanged')
    return { changed: false, error: err?.message }
  }
}

/**
 * Watch project folder for changes on host filesystem and automatically sync them into Overleaf.
 */
function watchProjectFolder(projectId, targetDir, userId, projectName = '') {
  const key = String(projectId)
  if (activeWatchers.has(key)) {
    const existing = activeWatchers.get(key)
    if (existing.targetDir === targetDir) {
      if (projectName) existing.projectName = projectName
      return
    }
    try {
      existing.watcher.close()
    } catch {}
    activeWatchers.delete(key)
  }

  try {
    if (!fs.existsSync(targetDir)) return
    let debounceTimer = null
    const watcherEntry = { watcher: null, targetDir, projectName: projectName || '' }

    const watcher = fs.watch(
      targetDir,
      { recursive: true },
      (eventType, filename) => {
        if (!filename) return
        const relCandidate = String(filename).replace(/\\/g, '/')
        if (shouldIgnoreHostFile(relCandidate, watcherEntry.projectName, key)) return
        if (
          activeIngests.has(key) ||
          activeExports.has(key) ||
          Date.now() < (suppressWatcherUntil.get(key) || 0)
        ) {
          return
        }

        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(async () => {
          debounceTimer = null
          if (
            activeIngests.has(key) ||
            activeExports.has(key) ||
            Date.now() < (suppressWatcherUntil.get(key) || 0)
          ) {
            return
          }
          try {
            const detection = await detectHostChanges(
              key,
              targetDir,
              watcherEntry.projectName,
              0
            )
            if (!detection.hostChanged) {
              return
            }
            logger.info(
              { projectId: key, filename: detection.relPath || relCandidate, eventType, reason: detection.reason },
              'local-sync: host change verified via watcher, syncing into Overleaf'
            )
            await syncProject(key, {
              direction: 'bidirectional',
              hostTriggered: true,
              userId,
              force: true,
            })
          } catch (err) {
            logger.warn({ err, projectId: key }, 'local-sync: watcher sync failed')
          }
        }, 1200)

        if (typeof debounceTimer.unref === 'function') {
          debounceTimer.unref()
        }
      }
    )

    if (typeof watcher.unref === 'function') {
      watcher.unref()
    }

    watcher.on('error', err => {
      logger.warn({ err, projectId: key, targetDir }, 'local-sync: watcher error')
      try {
        watcher.close()
      } catch {}
      activeWatchers.delete(key)
    })

    watcherEntry.watcher = watcher
    activeWatchers.set(key, watcherEntry)
  } catch (err) {
    logger.warn(
      { err, projectId: key, targetDir },
      'local-sync: failed starting directory watcher'
    )
  }
}

function unwatchProjectFolder(projectId) {
  const key = String(projectId)
  if (activeWatchers.has(key)) {
    try {
      activeWatchers.get(key).watcher.close()
    } catch {}
    activeWatchers.delete(key)
  }
}

/**
 * Debounced sync trigger for Overleaf editor/upload/rename/compile events.
 */
function scheduleSync(projectId, options = {}) {
  if (!projectId) return
  const key = String(projectId)
  if (activeIngests.has(key) || activeExports.has(key)) return

  const existing = pendingSyncs.get(key)
  const direction =
    options.direction || existing?.options?.direction || 'overleaf-to-host'
  const mergedOptions = {
    ...(existing?.options || {}),
    ...options,
    direction,
    cleanOld: Boolean(existing?.options?.cleanOld || options.cleanOld),
    oldDir: options.oldDir || existing?.options?.oldDir || null,
    compiledPdf: options.compiledPdf || existing?.options?.compiledPdf || null,
  }
  if (existing?.timer) {
    clearTimeout(existing.timer)
  }

  const timer = setTimeout(() => {
    pendingSyncs.delete(key)
    if (activeIngests.has(key)) return
    syncProject(key, mergedOptions).catch(err => {
      logger.error({ err, projectId: key }, 'local-sync: background sync failed')
    })
  }, DEBOUNCE_MS)

  if (typeof timer.unref === 'function') {
    timer.unref()
  }

  pendingSyncs.set(key, { timer, options: mergedOptions })
}

async function getSettings(userId) {
  const baseDir = await getUserBaseDir(userId)
  let serviceHealthy = false
  let daemonInfo = null
  try {
    const { statusCode, data } = await callDaemon('GET', '/health', null, 3000)
    serviceHealthy = statusCode === 200 && Boolean(data?.ok)
    daemonInfo = data
  } catch {
    serviceHealthy = false
  }
  const presets = [DEFAULT_BASE_DIR]
  const docsDir = path.join(ALLOWED_ROOT, 'Documents')
  const desktopDir = path.join(ALLOWED_ROOT, 'Desktop')
  if (fs.existsSync(docsDir)) {
    presets.push(path.join(docsDir, 'Overleaf'))
  }
  if (fs.existsSync(desktopDir)) {
    presets.push(path.join(desktopDir, 'Overleaf'))
  }
  if (presets.length === 1) {
    presets.push(path.join(ALLOWED_ROOT, 'Papers'))
  }

  return {
    baseDir,
    defaultBaseDir: DEFAULT_BASE_DIR,
    allowedRoot: ALLOWED_ROOT,
    serviceHealthy,
    presets: Array.from(new Set(presets)),
    daemonUid: daemonInfo?.uid ?? null,
  }
}

async function updateBaseDir(
  userId,
  rawBaseDir,
  { syncAll = true, cleanOld = false } = {}
) {
  const { statusCode, data } = await callDaemon('POST', '/validate', {
    path: rawBaseDir,
  })
  if (statusCode !== 200 || !data?.ok) {
    const err = new Error(data?.error || 'Invalid base folder path')
    err.statusCode = 400
    throw err
  }
  const normalizedBaseDir = data.normalizedPath

  if (data.existingProjectId) {
    const err = new Error(
      `This folder is already synced directly to project "${data.existingProjectName || data.existingProjectId}". Choose a parent/base directory instead.`
    )
    err.statusCode = 400
    throw err
  }

  const oldBaseDir = await getUserBaseDir(userId)
  const ownedProjects = await Project.find(
    { owner_ref: userId },
    {
      _id: 1,
      name: 1,
      owner_ref: 1,
      trashed: 1,
      localFolderPath: 1,
      localFolderSyncEnabled: 1,
      localFolderLastSyncedPath: 1,
    }
  ).lean()

  const activeProjects = ownedProjects.filter(
    p => !ProjectHelper.isTrashed(p, userId)
  )

  for (const p of activeProjects) {
    if (
      p.localFolderPath &&
      path.resolve(p.localFolderPath) === normalizedBaseDir
    ) {
      const err = new Error(
        `Cannot use "${normalizedBaseDir}" as the base folder because project "${p.name}" already uses it directly as a custom folder.`
      )
      err.statusCode = 400
      throw err
    }
  }

  const oldMap = resolveFolderPathsForProjects(oldBaseDir, activeProjects)

  await User.updateOne(
    { _id: userId },
    { $set: { localSyncBaseDir: normalizedBaseDir } }
  ).exec()

  await callDaemon('POST', '/mkdir', { path: normalizedBaseDir })

  const syncResults = []
  if (syncAll) {
    for (const p of activeProjects) {
      if (p.localFolderSyncEnabled === false) continue
      if (p.localFolderPath) continue
      const prevInfo = oldMap.get(String(p._id))
      const oldDir =
        p.localFolderLastSyncedPath || prevInfo?.effectivePath || null
      const res = await syncProject(String(p._id), {
        oldDir,
        cleanOld: Boolean(cleanOld && oldBaseDir !== normalizedBaseDir),
      })
      syncResults.push(res)
    }
  }

  const settings = await getSettings(userId)
  return {
    settings,
    previousBaseDir: oldBaseDir,
    syncedCount: syncResults.filter(r => r.ok).length,
    failedCount: syncResults.filter(r => !r.ok && !r.skipped).length,
    results: syncResults,
  }
}

async function updateProjectFolder(
  projectId,
  userId,
  { customFolderPath = null, syncEnabled = true, syncNow = true, cleanOld = false }
) {
  const project = await Project.findById(projectId, {
    _id: 1,
    name: 1,
    owner_ref: 1,
    trashed: 1,
    localFolderPath: 1,
    localFolderSyncEnabled: 1,
    localFolderLastSyncedPath: 1,
  }).lean()

  if (!project) {
    const err = new Error('Project not found')
    err.statusCode = 404
    throw err
  }

  const ownerId = String(project.owner_ref || userId)
  const baseDir = await getUserBaseDir(ownerId)
  const prevResolved = await getResolvedProjectFolder(project, baseDir)
  const oldDir = project.localFolderLastSyncedPath || prevResolved.effectivePath

  let normalizedCustomPath = null
  if (customFolderPath != null && String(customFolderPath).trim() !== '') {
    const { statusCode, data } = await callDaemon('POST', '/validate', {
      path: String(customFolderPath).trim(),
    })
    if (statusCode !== 200 || !data?.ok) {
      const err = new Error(data?.error || 'Invalid folder path')
      err.statusCode = 400
      throw err
    }
    normalizedCustomPath = data.normalizedPath

    if (
      data.existingProjectId &&
      String(data.existingProjectId) !== String(projectId)
    ) {
      const err = new Error(
        `Folder "${normalizedCustomPath}" is already synced with another project ("${data.existingProjectName || data.existingProjectId}").`
      )
      err.statusCode = 409
      throw err
    }

    if (normalizedCustomPath.toLowerCase() === baseDir.toLowerCase()) {
      const err = new Error(
        `Choose a subfolder inside "${baseDir}" rather than the base folder itself.`
      )
      err.statusCode = 400
      throw err
    }

    const otherProjects = await Project.find(
      {
        _id: { $ne: project._id },
        $or: [
          { owner_ref: project.owner_ref },
          { localFolderPath: { $ne: null } },
        ],
      },
      { _id: 1, name: 1, owner_ref: 1, trashed: 1, localFolderPath: 1 }
    ).lean()

    const otherActive = otherProjects.filter(
      p => !ProjectHelper.isTrashed(p, p.owner_ref || ownerId)
    )
    const otherOwnerProjects = otherActive.filter(
      p => String(p.owner_ref) === ownerId
    )
    const ownerResolvedMap = resolveFolderPathsForProjects(
      baseDir,
      otherOwnerProjects
    )

    for (const other of otherActive) {
      const otherPath =
        other.localFolderPath ||
        ownerResolvedMap.get(String(other._id))?.effectivePath
      if (!otherPath) continue
      if (
        doPathsOverlap(normalizedCustomPath, otherPath, {
          caseInsensitive: true,
        })
      ) {
        const err = new Error(
          `Folder "${normalizedCustomPath}" conflicts with project "${other.name}" (${otherPath}). Please select a separate folder.`
        )
        err.statusCode = 409
        throw err
      }
    }
  }

  await Project.updateOne(
    { _id: projectId },
    {
      $set: {
        localFolderPath: normalizedCustomPath,
        localFolderSyncEnabled: Boolean(syncEnabled),
        ...(syncEnabled
          ? {}
          : {
              localFolderLastSyncStatus: 'disabled',
              localFolderLastSyncError: null,
            }),
      },
    }
  ).exec()

  if (!syncEnabled) {
    unwatchProjectFolder(projectId)
  }

  let syncResult = null
  if (syncEnabled && syncNow) {
    syncResult = await syncProject(String(projectId), {
      force: true,
      oldDir,
      cleanOld: Boolean(cleanOld),
      userId,
    })
    if (!syncResult.ok) {
      const err = new Error(syncResult.error || 'Failed to sync to new folder')
      err.statusCode = 400
      throw err
    }
  }

  const updated = await Project.findById(projectId, {
    _id: 1,
    name: 1,
    owner_ref: 1,
    localFolderPath: 1,
    localFolderSyncEnabled: 1,
    localFolderLastSyncedAt: 1,
    localFolderLastSyncStatus: 1,
    localFolderLastSyncError: 1,
    localFolderLastSyncedPath: 1,
    localFolderFileCount: 1,
    localFolderHasPdf: 1,
  }).lean()

  const resolvedAfter = await getResolvedProjectFolder(updated, baseDir)
  const localFolder = {
    customPath: updated.localFolderPath || null,
    effectivePath: resolvedAfter.effectivePath,
    isCustom: resolvedAfter.isCustom,
    syncEnabled: updated.localFolderSyncEnabled !== false,
    lastSyncedAt: updated.localFolderLastSyncedAt
      ? new Date(updated.localFolderLastSyncedAt).toISOString()
      : null,
    lastSyncedPath: updated.localFolderLastSyncedPath || null,
    status:
      updated.localFolderSyncEnabled === false
        ? 'disabled'
        : updated.localFolderLastSyncStatus || 'not_synced',
    error: updated.localFolderLastSyncError || null,
    fileCount:
      typeof updated.localFolderFileCount === 'number'
        ? updated.localFolderFileCount
        : null,
    hasPdf: Boolean(updated.localFolderHasPdf),
  }

  return {
    ok: true,
    localFolder,
    syncResult,
  }
}

async function syncAllUserProjects(userId) {
  const allProjects = await ProjectGetter.promises.findAllUsersProjects(
    userId,
    '_id name owner_ref trashed localFolderPath localFolderSyncEnabled localFolderLastSyncedPath'
  )

  const seen = new Set()
  const candidates = []
  for (const list of [
    allProjects.owned || [],
    allProjects.readAndWrite || [],
    allProjects.readOnly || [],
  ]) {
    for (const p of list) {
      const id = String(p._id)
      if (seen.has(id)) continue
      seen.add(id)
      if (ProjectHelper.isTrashed(p, userId)) continue
      if (p.localFolderSyncEnabled === false) continue
      candidates.push(p)
    }
  }

  const results = []
  for (const p of candidates) {
    const res = await syncProject(String(p._id), { force: false, userId })
    results.push(res)
  }

  return {
    ok: true,
    total: candidates.length,
    syncedCount: results.filter(r => r.ok).length,
    failedCount: results.filter(r => !r.ok && !r.skipped).length,
    results,
  }
}

async function getProjectFolderInfo(projectId, userId) {
  const project = await Project.findById(projectId, {
    _id: 1,
    name: 1,
    owner_ref: 1,
    localFolderPath: 1,
    localFolderSyncEnabled: 1,
    localFolderLastSyncedAt: 1,
    localFolderLastSyncStatus: 1,
    localFolderLastSyncError: 1,
    localFolderLastSyncedPath: 1,
    localFolderFileCount: 1,
    localFolderHasPdf: 1,
  }).lean()
  if (!project) return null
  const ownerId = String(project.owner_ref || userId)
  const baseDir = await getUserBaseDir(ownerId)
  const resolved = await getResolvedProjectFolder(project, baseDir)
  return {
    customPath: project.localFolderPath || null,
    effectivePath: resolved.effectivePath,
    isCustom: resolved.isCustom,
    syncEnabled: project.localFolderSyncEnabled !== false,
    lastSyncedAt: project.localFolderLastSyncedAt
      ? new Date(project.localFolderLastSyncedAt).toISOString()
      : null,
    lastSyncedPath: project.localFolderLastSyncedPath || null,
    status:
      project.localFolderSyncEnabled === false
        ? 'disabled'
        : project.localFolderLastSyncStatus || 'not_synced',
    error: project.localFolderLastSyncError || null,
    fileCount:
      typeof project.localFolderFileCount === 'number'
        ? project.localFolderFileCount
        : null,
    hasPdf: Boolean(project.localFolderHasPdf),
  }
}

async function browseDirectories(rawPath) {
  const { statusCode, data } = await callDaemon('POST', '/browse', {
    path: rawPath || ALLOWED_ROOT,
  })
  if (statusCode !== 200 || !data?.ok) {
    const err = new Error(data?.error || 'Could not browse directory')
    err.statusCode = 400
    throw err
  }
  return data
}

async function createDirectory(rawPath) {
  const { statusCode, data } = await callDaemon('POST', '/mkdir', {
    path: rawPath,
  })
  if (statusCode !== 200 || !data?.ok) {
    const err = new Error(data?.error || 'Could not create directory')
    err.statusCode = 400
    throw err
  }
  return data
}

const LocalProjectSyncManager = {
  getSettings,
  getUserBaseDir,
  updateBaseDir,
  updateProjectFolder,
  syncProject,
  syncFromLocalFolder,
  syncFromLocalFolderIfChanged,
  syncAllUserProjects,
  scheduleSync,
  buildProjectFolderInfoMap,
  getProjectFolderInfo,
  browseDirectories,
  createDirectory,
  watchProjectFolder,
  unwatchProjectFolder,
}

export default LocalProjectSyncManager
