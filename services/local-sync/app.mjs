import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {
  ALLOWED_ROOT,
  DEFAULT_BASE_DIR,
  SYNC_MANIFEST_FILENAME,
  isBrowsableDirectoryEntry,
  isPathEqualOrInside,
  validateHostFolderPath,
  validateRelativeEntityPath,
} from './path-utils.mjs'

const SOCKET_PATH =
  process.env.LOCAL_SYNC_SOCKET_PATH || '/run/overleaf-local-sync/sync.sock'
const STAGE_ROOT = path.resolve(
  process.env.LOCAL_SYNC_STAGE_ROOT || '/tmp/overleaf-local-sync-stage'
)
const MAX_BODY_BYTES = 10 * 1024 * 1024 // 10MB JSON metadata cap

/** @type {Map<string, Promise<void>>} */
const projectLocks = new Map()

/**
 * Serialize async operations by key to prevent concurrent sync races.
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withLock(key, fn) {
  const prev = projectLocks.get(key) || Promise.resolve()
  let release
  const current = new Promise(resolve => {
    release = resolve
  })
  const chained = prev.then(() => current)
  projectLocks.set(key, chained)
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (projectLocks.get(key) === chained) {
      projectLocks.delete(key)
    }
  }
}

function log(level, msg, meta = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    name: 'local-sync',
    msg,
    ...meta,
  }
  const line = JSON.stringify(entry)
  if (level === 'error') {
    process.stderr.write(line + '\n')
  } else {
    process.stdout.write(line + '\n')
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('Invalid JSON payload'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readManifest(dir) {
  const manifestPath = path.join(dir, SYNC_MANIFEST_FILENAME)
  try {
    const stat = fs.lstatSync(manifestPath)
    if (!stat.isFile()) return null
    const raw = fs.readFileSync(manifestPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    return null
  }
}

function writeFileAtomic(destPath, contentOrSourcePath, isCopy = false) {
  const dir = path.dirname(destPath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 })

  // Refuse to write through a symlink at destPath
  try {
    const existing = fs.lstatSync(destPath)
    if (existing.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlink at ${destPath}`)
    }
    if (existing.isDirectory()) {
      throw new Error(`Refusing to overwrite directory with file at ${destPath}`)
    }
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err
  }

  const tmpName = `.overleaf-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  const tmpPath = path.join(dir, tmpName)
  try {
    if (isCopy) {
      fs.copyFileSync(contentOrSourcePath, tmpPath)
      fs.chmodSync(tmpPath, 0o644)
    } else {
      fs.writeFileSync(tmpPath, contentOrSourcePath, {
        encoding: 'utf8',
        mode: 0o644,
      })
    }
    fs.renameSync(tmpPath, destPath)
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {}
    throw err
  }
}

function sha1File(filePath) {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex')
}

function filesHaveIdenticalBytes(srcPath, destPath) {
  try {
    const destStat = fs.lstatSync(destPath)
    if (!destStat.isFile() || destStat.isSymbolicLink()) return false
    const srcStat = fs.statSync(srcPath)
    if (srcStat.size !== destStat.size) return false
    if (srcStat.size <= 1024 * 1024) {
      return Buffer.compare(fs.readFileSync(srcPath), fs.readFileSync(destPath)) === 0
    }
    return sha1File(srcPath) === sha1File(destPath)
  } catch {
    return false
  }
}

/**
 * Remove empty ancestor directories strictly inside `stopAtDir` (never removes stopAtDir unless removeStopDirIfEmpty is true).
 */
function pruneEmptyDirsUpward(startDir, stopAtDir, removeStopDirIfEmpty = false) {
  let cursor = path.resolve(startDir)
  const resolvedStop = path.resolve(stopAtDir)
  while (isPathEqualOrInside(resolvedStop, cursor)) {
    if (cursor === resolvedStop && !removeStopDirIfEmpty) {
      break
    }
    try {
      const entries = fs.readdirSync(cursor)
      if (entries.length === 0) {
        fs.rmdirSync(cursor)
      } else {
        break
      }
    } catch {
      break
    }
    if (cursor === resolvedStop) break
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
}

function checkWritable(targetPath) {
  let cursor = path.resolve(targetPath)
  while (true) {
    try {
      fs.accessSync(cursor, fs.constants.F_OK)
      try {
        fs.accessSync(cursor, fs.constants.W_OK | fs.constants.R_OK)
        return { writable: true, checkedPath: cursor }
      } catch {
        return {
          writable: false,
          checkedPath: cursor,
          error: `Permission denied: folder is not writable (${cursor})`,
        }
      }
    } catch {
      const parent = path.dirname(cursor)
      if (parent === cursor) {
        return { writable: false, checkedPath: cursor, error: 'Parent path not found' }
      }
      cursor = parent
    }
  }
}

async function handleValidate(body) {
  const check = validateHostFolderPath(body.path, { checkSymlinks: true })
  if (!check.ok) {
    return { status: 400, payload: { ok: false, error: check.error } }
  }
  const writability = checkWritable(check.normalizedPath)
  if (!writability.writable) {
    return {
      status: 400,
      payload: {
        ok: false,
        normalizedPath: check.normalizedPath,
        exists: check.exists,
        writable: false,
        error: writability.error,
      },
    }
  }

  let existingProjectId = null
  let existingProjectName = null
  if (check.exists) {
    const manifest = readManifest(check.normalizedPath)
    if (manifest?.projectId) {
      existingProjectId = manifest.projectId
      existingProjectName = manifest.projectName || null
    }
  }

  return {
    status: 200,
    payload: {
      ok: true,
      normalizedPath: check.normalizedPath,
      exists: Boolean(check.exists),
      writable: true,
      existingProjectId,
      existingProjectName,
    },
  }
}

async function handleBrowse(body) {
  const requested = body.path || ALLOWED_ROOT
  const check = validateHostFolderPath(requested, {
    checkSymlinks: true,
    allowRootForBrowse: true,
  })
  if (!check.ok) {
    return { status: 400, payload: { ok: false, error: check.error } }
  }

  let currentPath = check.normalizedPath
  // If requested path doesn't exist yet, fall back to nearest existing ancestor inside ALLOWED_ROOT
  while (!fs.existsSync(currentPath) && currentPath !== ALLOWED_ROOT) {
    const parent = path.dirname(currentPath)
    if (parent === currentPath || !isPathEqualOrInside(ALLOWED_ROOT, parent)) {
      currentPath = ALLOWED_ROOT
      break
    }
    currentPath = parent
  }

  const stat = fs.statSync(currentPath)
  if (!stat.isDirectory()) {
    currentPath = path.dirname(currentPath)
  }

  const entries = fs.readdirSync(currentPath, { withFileTypes: true })
  const directories = []
  for (const entry of entries) {
    if (!isBrowsableDirectoryEntry(currentPath, entry.name)) continue
    const fullPath = path.join(currentPath, entry.name)
    let isDir = entry.isDirectory()
    if (!isDir && entry.isSymbolicLink()) {
      try {
        const real = fs.realpathSync(fullPath)
        if (
          isPathEqualOrInside(ALLOWED_ROOT, real) &&
          fs.statSync(real).isDirectory()
        ) {
          isDir = true
        }
      } catch {
        isDir = false
      }
    }
    if (!isDir) continue
    directories.push({
      name: entry.name,
      path: fullPath,
    })
  }
  directories.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  )

  const parentPath =
    currentPath === ALLOWED_ROOT ? null : path.dirname(currentPath)

  return {
    status: 200,
    payload: {
      ok: true,
      currentPath,
      parentPath,
      allowedRoot: ALLOWED_ROOT,
      defaultBaseDir: DEFAULT_BASE_DIR,
      directories,
    },
  }
}

async function handleMkdir(body) {
  const check = validateHostFolderPath(body.path, { checkSymlinks: true })
  if (!check.ok) {
    return { status: 400, payload: { ok: false, error: check.error } }
  }
  const writability = checkWritable(check.normalizedPath)
  if (!writability.writable) {
    return { status: 400, payload: { ok: false, error: writability.error } }
  }
  fs.mkdirSync(check.normalizedPath, { recursive: true, mode: 0o755 })
  return {
    status: 200,
    payload: { ok: true, normalizedPath: check.normalizedPath },
  }
}

async function handleSync(body) {
  const {
    projectId,
    projectName,
    targetDir,
    stagingDir,
    files = [],
    oldDir = null,
    cleanOld = false,
  } = body

  if (!projectId || typeof projectId !== 'string') {
    return { status: 400, payload: { ok: false, error: 'Missing projectId' } }
  }
  if (!stagingDir || typeof stagingDir !== 'string') {
    return { status: 400, payload: { ok: false, error: 'Missing stagingDir' } }
  }
  const resolvedStage = path.resolve(stagingDir)
  if (
    !isPathEqualOrInside(STAGE_ROOT, resolvedStage) ||
    resolvedStage === STAGE_ROOT
  ) {
    return { status: 400, payload: { ok: false, error: 'Invalid stagingDir' } }
  }

  const targetCheck = validateHostFolderPath(targetDir, { checkSymlinks: true })
  if (!targetCheck.ok) {
    return { status: 400, payload: { ok: false, error: targetCheck.error } }
  }
  const normalizedTarget = targetCheck.normalizedPath

  let normalizedOld = null
  if (oldDir) {
    const oldCheck = validateHostFolderPath(oldDir, { checkSymlinks: true })
    if (oldCheck.ok) {
      normalizedOld = oldCheck.normalizedPath
    }
  }

  return await withLock(`project:${projectId}`, async () => {
    // 1. Check writability
    const writability = checkWritable(normalizedTarget)
    if (!writability.writable) {
      return { status: 400, payload: { ok: false, error: writability.error } }
    }

    // 2. Ensure targetDir doesn't already belong to a DIFFERENT Overleaf project
    const existingManifest = readManifest(normalizedTarget)
    if (
      existingManifest &&
      existingManifest.projectId &&
      String(existingManifest.projectId) !== String(projectId)
    ) {
      return {
        status: 409,
        payload: {
          ok: false,
          error: `Target folder "${normalizedTarget}" is already synced with another Overleaf project ("${existingManifest.projectName || existingManifest.projectId}"). Choose a different folder.`,
        },
      }
    }

    // 3. Validate all relative file paths before writing anything
    const validatedFiles = []
    const validatedSet = new Set()
    for (const rawRel of files) {
      const v = validateRelativeEntityPath(rawRel)
      if (!v.ok) {
        return { status: 400, payload: { ok: false, error: v.error } }
      }
      const srcPath = path.resolve(resolvedStage, v.relPath)
      const destPath = path.resolve(normalizedTarget, v.relPath)
      if (
        !isPathEqualOrInside(resolvedStage, srcPath) ||
        !isPathEqualOrInside(normalizedTarget, destPath)
      ) {
        return {
          status: 400,
          payload: { ok: false, error: `Unsafe path escape for ${rawRel}` },
        }
      }
      if (!fs.existsSync(srcPath)) {
        return {
          status: 400,
          payload: { ok: false, error: `Staged file missing: ${v.relPath}` },
        }
      }
      if (!validatedSet.has(v.relPath)) {
        validatedSet.add(v.relPath)
        validatedFiles.push({ relPath: v.relPath, srcPath, destPath })
      }
    }

    // 4. Create targetDir and verify realpath again after creation
    fs.mkdirSync(normalizedTarget, { recursive: true, mode: 0o755 })
    const realTarget = fs.realpathSync(normalizedTarget)
    if (!isPathEqualOrInside(ALLOWED_ROOT, realTarget)) {
      return {
        status: 400,
        payload: {
          ok: false,
          error: `Target directory resolves outside ${ALLOWED_ROOT}`,
        },
      }
    }

    // 5. Copy changed/new staged files atomically into targetDir and capture post-write stats
    const callerBaselines =
      body.baselines && typeof body.baselines === 'object' ? body.baselines : {}
    let writtenFilesCount = 0
    let skippedUnchangedCount = 0
    const nextBaselines = {}

    for (const item of validatedFiles) {
      if (filesHaveIdenticalBytes(item.srcPath, item.destPath)) {
        skippedUnchangedCount++
      } else {
        writeFileAtomic(item.destPath, item.srcPath, true)
        writtenFilesCount++
      }
      try {
        const st = fs.statSync(item.destPath)
        const callerBase = callerBaselines[item.relPath]
        nextBaselines[item.relPath] = {
          hostSha1:
            callerBase && typeof callerBase.hostSha1 === 'string'
              ? callerBase.hostSha1
              : sha1File(item.destPath),
          overleafHash:
            callerBase && typeof callerBase.overleafHash === 'string'
              ? callerBase.overleafHash
              : null,
          kind:
            callerBase && typeof callerBase.kind === 'string'
              ? callerBase.kind
              : null,
          mtimeMs: st.mtimeMs,
          size: st.size,
        }
      } catch {}
    }

    // 6. Prune stale files ONLY if they were previously tracked by Overleaf sync manifest
    let removedStaleCount = 0
    if (existingManifest && Array.isArray(existingManifest.files)) {
      for (const prevRel of existingManifest.files) {
        const v = validateRelativeEntityPath(prevRel)
        if (!v.ok) continue
        if (validatedSet.has(v.relPath)) continue
        const stalePath = path.resolve(normalizedTarget, v.relPath)
        if (!isPathEqualOrInside(normalizedTarget, stalePath)) continue
        try {
          const st = fs.lstatSync(stalePath)
          if (st.isFile()) {
            fs.unlinkSync(stalePath)
            removedStaleCount++
            pruneEmptyDirsUpward(path.dirname(stalePath), normalizedTarget, false)
          }
        } catch (err) {
          if (!err || err.code !== 'ENOENT') {
            log('warn', 'failed removing stale synced file', {
              stalePath,
              err: err?.message,
            })
          }
        }
      }
    }

    // 7. Write updated manifest atomically
    const syncedAt = new Date().toISOString()
    const newManifest = {
      version: 1,
      projectId: String(projectId),
      projectName: String(projectName || ''),
      syncedAt,
      files: validatedFiles.map(f => f.relPath).sort(),
      baselines: nextBaselines,
    }
    writeFileAtomic(
      path.join(normalizedTarget, SYNC_MANIFEST_FILENAME),
      JSON.stringify(newManifest, null, 2) + '\n',
      false
    )

    // 8. Optionally clean up old folder ONLY AFTER new folder sync succeeded completely
    let cleanedOldDir = false
    if (cleanOld && normalizedOld && normalizedOld !== normalizedTarget) {
      const oldManifest = readManifest(normalizedOld)
      if (
        oldManifest &&
        String(oldManifest.projectId) === String(projectId) &&
        Array.isArray(oldManifest.files)
      ) {
        for (const oldRel of oldManifest.files) {
          const v = validateRelativeEntityPath(oldRel)
          if (!v.ok) continue
          const oldFile = path.resolve(normalizedOld, v.relPath)
          if (!isPathEqualOrInside(normalizedOld, oldFile)) continue
          try {
            const st = fs.lstatSync(oldFile)
            if (st.isFile()) {
              fs.unlinkSync(oldFile)
              pruneEmptyDirsUpward(path.dirname(oldFile), normalizedOld, false)
            }
          } catch {}
        }
        try {
          fs.unlinkSync(path.join(normalizedOld, SYNC_MANIFEST_FILENAME))
        } catch {}
        pruneEmptyDirsUpward(normalizedOld, normalizedOld, true)
        cleanedOldDir = true
      }
    }

    log('info', 'synced project to local folder', {
      projectId,
      targetDir: normalizedTarget,
      fileCount: validatedFiles.length,
      writtenFilesCount,
      skippedUnchangedCount,
      removedStaleCount,
      cleanedOldDir,
    })

    return {
      status: 200,
      payload: {
        ok: true,
        targetDir: normalizedTarget,
        syncedFilesCount: validatedFiles.length,
        writtenFilesCount,
        skippedUnchangedCount,
        removedStaleCount,
        cleanedOldDir,
        syncedAt,
      },
    }
  })
}

async function handleManifestUpdate(body) {
  const { projectId, projectName, targetDir, files = [], baselines = {} } = body
  if (!projectId || typeof projectId !== 'string') {
    return { status: 400, payload: { ok: false, error: 'Missing projectId' } }
  }
  const targetCheck = validateHostFolderPath(targetDir, { checkSymlinks: true })
  if (!targetCheck.ok) {
    return { status: 400, payload: { ok: false, error: targetCheck.error } }
  }
  const normalizedTarget = targetCheck.normalizedPath
  if (!fs.existsSync(normalizedTarget)) {
    return { status: 404, payload: { ok: false, error: 'Target folder does not exist' } }
  }

  return await withLock(`project:${projectId}`, async () => {
    const existingManifest = readManifest(normalizedTarget)
    if (
      existingManifest &&
      existingManifest.projectId &&
      String(existingManifest.projectId) !== String(projectId)
    ) {
      return {
        status: 409,
        payload: {
          ok: false,
          error: `Target folder "${normalizedTarget}" is synced with another project`,
        },
      }
    }

    const validRelFiles = []
    const nextBaselines = {}
    const seen = new Set()
    for (const rawRel of Array.isArray(files) ? files : []) {
      const v = validateRelativeEntityPath(rawRel)
      if (!v.ok || seen.has(v.relPath)) continue
      const destPath = path.resolve(normalizedTarget, v.relPath)
      if (!isPathEqualOrInside(normalizedTarget, destPath)) continue
      seen.add(v.relPath)
      validRelFiles.push(v.relPath)
      const base = baselines && typeof baselines === 'object' ? baselines[v.relPath] : null
      try {
        const st = fs.statSync(destPath)
        if (st.isFile()) {
          nextBaselines[v.relPath] = {
            hostSha1:
              base && typeof base.hostSha1 === 'string'
                ? base.hostSha1
                : sha1File(destPath),
            overleafHash:
              base && typeof base.overleafHash === 'string' ? base.overleafHash : null,
            kind: base && typeof base.kind === 'string' ? base.kind : null,
            mtimeMs: st.mtimeMs,
            size: st.size,
          }
        }
      } catch {}
    }

    const syncedAt = new Date().toISOString()
    const nextManifest = {
      version: 1,
      projectId: String(projectId),
      projectName: String(projectName || existingManifest?.projectName || ''),
      syncedAt,
      files: validRelFiles.sort(),
      baselines: nextBaselines,
    }
    writeFileAtomic(
      path.join(normalizedTarget, SYNC_MANIFEST_FILENAME),
      JSON.stringify(nextManifest, null, 2) + '\n',
      false
    )
    return { status: 200, payload: { ok: true, syncedAt } }
  })
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, {
        ok: true,
        uid: process.getuid?.(),
        gid: process.getgid?.(),
        allowedRoot: ALLOWED_ROOT,
        defaultBaseDir: DEFAULT_BASE_DIR,
      })
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      if (req.url === '/validate') {
        const result = await handleValidate(body)
        return sendJson(res, result.status, result.payload)
      }
      if (req.url === '/browse') {
        const result = await handleBrowse(body)
        return sendJson(res, result.status, result.payload)
      }
      if (req.url === '/mkdir') {
        const result = await handleMkdir(body)
        return sendJson(res, result.status, result.payload)
      }
      if (req.url === '/sync') {
        const result = await handleSync(body)
        return sendJson(res, result.status, result.payload)
      }
      if (req.url === '/manifest') {
        const result = await handleManifestUpdate(body)
        return sendJson(res, result.status, result.payload)
      }
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' })
  } catch (err) {
    const status = err?.status || 500
    log('error', 'local-sync request failed', {
      url: req.url,
      err: err?.message || String(err),
    })
    return sendJson(res, status, {
      ok: false,
      error: err?.message || 'Internal local-sync error',
    })
  }
})

// Clean stale socket if present
try {
  fs.unlinkSync(SOCKET_PATH)
} catch {}

server.listen(SOCKET_PATH, () => {
  try {
    fs.chmodSync(SOCKET_PATH, 0o660)
  } catch (err) {
    log('warn', 'could not chmod socket', { SOCKET_PATH, err: err?.message })
  }
  log('info', 'local-sync daemon listening', {
    socketPath: SOCKET_PATH,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    allowedRoot: ALLOWED_ROOT,
    defaultBaseDir: DEFAULT_BASE_DIR,
  })
})

function shutdown() {
  server.close(() => {
    try {
      fs.unlinkSync(SOCKET_PATH)
    } catch {}
    process.exit(0)
  })
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
