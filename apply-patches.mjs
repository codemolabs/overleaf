import fs from 'node:fs'
import path from 'node:path'

const WEB_ROOT = process.env.OVERLEAF_WEB_ROOT || '/overleaf/services/web'
const STAGING_WEB_ROOT = path.join(import.meta.dirname, 'services', 'web')
const mode = process.argv.includes('--backend')
  ? 'backend'
  : process.argv.includes('--frontend')
    ? 'frontend'
    : 'all'

function removeExactIfPresent(relPath, target) {
  const fullPath = path.join(WEB_ROOT, relPath)
  const content = fs.readFileSync(fullPath, 'utf8')
  const idx = content.indexOf(target)
  if (idx === -1) {
    console.log(`[skip] ${relPath} already cleaned`)
    return
  }
  const updated = content.slice(0, idx) + content.slice(idx + target.length)
  fs.writeFileSync(fullPath, updated, 'utf8')
  console.log(`[ok] cleaned ${relPath}`)
}

function replaceIfPresent(relPath, target, replacement) {
  const fullPath = path.join(WEB_ROOT, relPath)
  const content = fs.readFileSync(fullPath, 'utf8')
  const idx = content.indexOf(target)
  if (idx === -1) {
    console.log(`[skip] ${relPath} replacement target not present`)
    return
  }
  const updated =
    content.slice(0, idx) + replacement + content.slice(idx + target.length)
  fs.writeFileSync(fullPath, updated, 'utf8')
  console.log(`[ok] updated ${relPath}`)
}

function copyStagedFile(relPath) {
  const src = path.join(STAGING_WEB_ROOT, relPath)
  const dest = path.join(WEB_ROOT, relPath)
  if (!fs.existsSync(src)) {
    throw new Error(`Missing staged source file: ${src}`)
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
  console.log(`[ok] copied staged ${relPath}`)
}

function replaceExact(relPath, target, replacement, marker) {
  const fullPath = path.join(WEB_ROOT, relPath)
  const content = fs.readFileSync(fullPath, 'utf8')
  if (marker && content.includes(marker)) {
    console.log(`[skip] ${relPath} already patched (${marker})`)
    return
  }
  const idx = content.indexOf(target)
  if (idx === -1) {
    throw new Error(
      `Patch target not found in ${relPath}!\nTarget snippet:\n${target}`
    )
  }
  const secondIdx = content.indexOf(target, idx + target.length)
  if (secondIdx !== -1) {
    throw new Error(
      `Patch target matched multiple times in ${relPath}!\nTarget snippet:\n${target}`
    )
  }
  const updated =
    content.slice(0, idx) + replacement + content.slice(idx + target.length)
  fs.writeFileSync(fullPath, updated, 'utf8')
  console.log(`[ok] patched ${relPath}`)
}

function applyBackendPatches() {
  // 0. Sync custom project sync handlers
  copyStagedFile('app/src/Features/Project/LocalProjectSyncPathUtils.mjs')
  copyStagedFile('app/src/Features/Project/LocalProjectSyncManager.mjs')
  copyStagedFile('app/src/Features/Project/LocalProjectSyncController.mjs')

  // 1. User model
  replaceExact(
    'app/src/models/User.mjs',
    `    stripeCustomerIds: {
      us: { type: String },
      uk: { type: String },
    },`,
    `    stripeCustomerIds: {
      us: { type: String },
      uk: { type: String },
    },
    localSyncBaseDir: { type: String },`,
    'localSyncBaseDir:'
  )

  // 2. Project model
  replaceExact(
    'app/src/models/Project.mjs',
    `    deferredTpdsFlushCounter: { type: Number },
    referenceFormat: { type: String },`,
    `    deferredTpdsFlushCounter: { type: Number },
    referenceFormat: { type: String },
    localFolderPath: { type: String },
    localFolderSyncEnabled: { type: Boolean, default: true },
    localFolderLastSyncedAt: { type: Date },
    localFolderLastSyncStatus: { type: String },
    localFolderLastSyncError: { type: String },
    localFolderLastSyncedPath: { type: String },
    localFolderFileCount: { type: Number },
    localFolderHasPdf: { type: Boolean, default: false },`,
    'localFolderPath:'
  )

  // 3. ProjectListController: import + include localFolder metadata
  replaceExact(
    'app/src/Features/Project/ProjectListController.mjs',
    `import UserSettingsHelper from './UserSettingsHelper.mjs'`,
    `import UserSettingsHelper from './UserSettingsHelper.mjs'
import LocalProjectSyncManager from './LocalProjectSyncManager.mjs'`,
    'LocalProjectSyncManager'
  )

  replaceExact(
    'app/src/Features/Project/ProjectListController.mjs',
    `    ProjectGetter.promises.findAllUsersProjects(
      userId,
      'name lastUpdated lastUpdatedBy publicAccesLevel archived trashed owner_ref tokens'
    ),`,
    `    ProjectGetter.promises.findAllUsersProjects(
      userId,
      'name lastUpdated lastUpdatedBy publicAccesLevel archived trashed owner_ref tokens localFolderPath localFolderSyncEnabled localFolderLastSyncedAt localFolderLastSyncStatus localFolderLastSyncError localFolderLastSyncedPath localFolderFileCount localFolderHasPdf'
    ),`,
    'localFolderLastSyncedPath'
  )

  replaceExact(
    'app/src/Features/Project/ProjectListController.mjs',
    `  const pagedProjects = _sortAndPaginate(filteredProjects, sort, page)

  const projects = await _injectProjectUsers(pagedProjects)

  return {
    totalSize: filteredProjects.length,
    projects,
  }`,
    `  const pagedProjects = _sortAndPaginate(filteredProjects, sort, page)

  const projects = await _injectProjectUsers(pagedProjects)

  const allRawProjects = [
    ...(allProjects.owned || []),
    ...(allProjects.readAndWrite || []),
    ...(allProjects.review || []),
    ...(allProjects.readOnly || []),
    ...(allProjects.tokenReadAndWrite || []),
    ...(allProjects.tokenReadOnly || []),
  ]
  const seenRawIds = new Set()
  const uniqueRawProjects = []
  for (const rawProj of allRawProjects) {
    const idStr = rawProj._id.toString()
    if (!seenRawIds.has(idStr)) {
      seenRawIds.add(idStr)
      uniqueRawProjects.push(rawProj)
    }
  }
  const localFolderMap = await LocalProjectSyncManager.buildProjectFolderInfoMap(
    userId,
    uniqueRawProjects
  )
  for (const proj of projects) {
    proj.localFolder = localFolderMap.get(proj.id)
  }

  return {
    totalSize: filteredProjects.length,
    projects,
  }`,
    'buildProjectFolderInfoMap'
  )

  // 4. Router: import + register local-sync endpoints
  replaceExact(
    'app/src/router.mjs',
    `import ProjectListController from './Features/Project/ProjectListController.mjs'`,
    `import ProjectListController from './Features/Project/ProjectListController.mjs'
import LocalProjectSyncController from './Features/Project/LocalProjectSyncController.mjs'`,
    'LocalProjectSyncController'
  )

  replaceExact(
    'app/src/router.mjs',
    `  webRouter.post(
    '/api/project',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.getProjects),
    ProjectListController.getProjectsJson
  )`,
    `  webRouter.post(
    '/api/project',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.getProjects),
    ProjectListController.getProjectsJson
  )
  webRouter.get(
    '/api/local-sync/settings',
    AuthenticationController.requireLogin(),
    LocalProjectSyncController.getSettings
  )
  webRouter.post(
    '/api/local-sync/settings',
    AuthenticationController.requireLogin(),
    LocalProjectSyncController.updateSettings
  )
  webRouter.post(
    '/api/local-sync/sync-all',
    AuthenticationController.requireLogin(),
    LocalProjectSyncController.syncAll
  )
  webRouter.get(
    '/api/local-sync/browse',
    AuthenticationController.requireLogin(),
    LocalProjectSyncController.browse
  )
  webRouter.post(
    '/api/local-sync/mkdir',
    AuthenticationController.requireLogin(),
    LocalProjectSyncController.createDirectory
  )
  webRouter.post(
    '/project/:Project_id/local-folder',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanAdminProject,
    LocalProjectSyncController.updateProjectFolder
  )
  webRouter.get(
    '/project/:Project_id/local-folder',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanReadProject,
    LocalProjectSyncController.getProjectFolder
  )
  webRouter.post(
    '/project/:Project_id/local-sync',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanReadProject,
    LocalProjectSyncController.syncProject
  )`,
    '/api/local-sync/settings'
  )

  // 5. TpdsUpdateSender: auto-sync hooks for all doc/file/project mutations (Overleaf -> host only)
  replaceExact(
    'app/src/Features/ThirdPartyDataStore/TpdsUpdateSender.mjs',
    `import UserGetterModule from '../User/UserGetter.mjs'`,
    `import UserGetterModule from '../User/UserGetter.mjs'
import LocalProjectSyncManager from '../Project/LocalProjectSyncManager.mjs'`,
    'LocalProjectSyncManager'
  )

  replaceExact(
    'app/src/Features/ThirdPartyDataStore/TpdsUpdateSender.mjs',
    `async function addDoc(params) {
  metrics.inc('tpds.add-doc')
  const { projectId, path, docId, projectName, rev, folderId } = params`,
    `async function addDoc(params) {
  metrics.inc('tpds.add-doc')
  const { projectId, path, docId, projectName, rev, folderId } = params
  LocalProjectSyncManager.scheduleSync(projectId, {
    direction: 'overleaf-to-host',
  })`,
    "addDoc(params) {\n  metrics.inc('tpds.add-doc')\n  const { projectId, path, docId, projectName, rev, folderId } = params\n  LocalProjectSyncManager.scheduleSync"
  )

  replaceExact(
    'app/src/Features/ThirdPartyDataStore/TpdsUpdateSender.mjs',
    `async function addFile(params) {
  metrics.inc('tpds.add-file')
  const {
    projectId,
    historyId,
    fileId,
    hash,
    path,
    projectName,
    rev,
    folderId,
  } = params`,
    `async function addFile(params) {
  metrics.inc('tpds.add-file')
  const {
    projectId,
    historyId,
    fileId,
    hash,
    path,
    projectName,
    rev,
    folderId,
  } = params
  LocalProjectSyncManager.scheduleSync(projectId, {
    direction: 'overleaf-to-host',
  })`,
    "addFile(params) {\n  metrics.inc('tpds.add-file')\n  const {\n    projectId,\n    historyId,\n    fileId,\n    hash,\n    path,\n    projectName,\n    rev,\n    folderId,\n  } = params\n  LocalProjectSyncManager.scheduleSync"
  )

  replaceExact(
    'app/src/Features/ThirdPartyDataStore/TpdsUpdateSender.mjs',
    `async function deleteEntity(params) {
  metrics.inc('tpds.delete-entity')
  const {
    projectId,
    path,
    projectName,
    entityId,
    entityType,
    subtreeEntityIds,
  } = params`,
    `async function deleteEntity(params) {
  metrics.inc('tpds.delete-entity')
  const {
    projectId,
    path,
    projectName,
    entityId,
    entityType,
    subtreeEntityIds,
  } = params
  LocalProjectSyncManager.scheduleSync(projectId, {
    direction: 'overleaf-to-host',
  })`,
    "subtreeEntityIds,\n  } = params\n  LocalProjectSyncManager.scheduleSync"
  )

  replaceExact(
    'app/src/Features/ThirdPartyDataStore/TpdsUpdateSender.mjs',
    `async function createProject(params) {
  if (!tpdsUrl) return // Overleaf Community Edition/Server Pro`,
    `async function createProject(params) {
  LocalProjectSyncManager.scheduleSync(params?.projectId, {
    direction: 'overleaf-to-host',
  })
  if (!tpdsUrl) return // Overleaf Community Edition/Server Pro`,
    'LocalProjectSyncManager.scheduleSync(params?.projectId'
  )

  replaceExact(
    'app/src/Features/ThirdPartyDataStore/TpdsUpdateSender.mjs',
    `async function moveEntity(params) {
  metrics.inc('tpds.move-entity')
  const { projectId, rev, entityId, entityType, folderId } = params`,
    `async function moveEntity(params) {
  metrics.inc('tpds.move-entity')
  const { projectId, rev, entityId, entityType, folderId } = params
  LocalProjectSyncManager.scheduleSync(projectId, {
    direction: 'overleaf-to-host',
    cleanOld: Boolean(params.newProjectName),
  })`,
    'cleanOld: Boolean(params.newProjectName)'
  )

  // Upgrade earlier un-directional scheduleSync calls if re-applying on an already-patched container
  replaceIfPresent(
    'app/src/Features/ThirdPartyDataStore/TpdsUpdateSender.mjs',
    `  LocalProjectSyncManager.scheduleSync(projectId)\n\n  const streamOrigin`,
    `  LocalProjectSyncManager.scheduleSync(projectId, {\n    direction: 'overleaf-to-host',\n  })\n\n  const streamOrigin`
  )
  replaceIfPresent(
    'app/src/Features/ThirdPartyDataStore/TpdsUpdateSender.mjs',
    `  LocalProjectSyncManager.scheduleSync(projectId)\n  await addEntity({`,
    `  LocalProjectSyncManager.scheduleSync(projectId, {\n    direction: 'overleaf-to-host',\n  })\n  await addEntity({`
  )
  replaceIfPresent(
    'app/src/Features/ThirdPartyDataStore/TpdsUpdateSender.mjs',
    `  LocalProjectSyncManager.scheduleSync(projectId)\n  await deleteEntity({`,
    `  LocalProjectSyncManager.scheduleSync(projectId, {\n    direction: 'overleaf-to-host',\n  })\n  await deleteEntity({`
  )
  replaceIfPresent(
    'app/src/Features/ThirdPartyDataStore/TpdsUpdateSender.mjs',
    `  LocalProjectSyncManager.scheduleSync(params?.projectId)\n  if (!tpdsUrl)`,
    `  LocalProjectSyncManager.scheduleSync(params?.projectId, {\n    direction: 'overleaf-to-host',\n  })\n  if (!tpdsUrl)`
  )
  replaceIfPresent(
    'app/src/Features/ThirdPartyDataStore/TpdsUpdateSender.mjs',
    `  LocalProjectSyncManager.scheduleSync(projectId, {\n    cleanOld: Boolean(params.newProjectName),\n  })`,
    `  LocalProjectSyncManager.scheduleSync(projectId, {\n    direction: 'overleaf-to-host',\n    cleanOld: Boolean(params.newProjectName),\n  })`
  )

  // 6. CompileController: sync compiled PDF after successful compile (Overleaf -> host only)
  replaceExact(
    'app/src/Features/Compile/CompileController.mjs',
    `import ClsiCacheHandler from './ClsiCacheHandler.mjs'`,
    `import ClsiCacheHandler from './ClsiCacheHandler.mjs'
import LocalProjectSyncManager from '../Project/LocalProjectSyncManager.mjs'`,
    'LocalProjectSyncManager'
  )

  replaceExact(
    'app/src/Features/Compile/CompileController.mjs',
    `    Metrics.inc('compile-status', 1, { status })`,
    `    Metrics.inc('compile-status', 1, { status })
    if (status === 'success') {
      LocalProjectSyncManager.scheduleSync(projectId, {
        direction: 'overleaf-to-host',
        compiledPdf: { buildId, userId },
      })
    }`,
    'compiledPdf: { buildId, userId }'
  )

  replaceIfPresent(
    'app/src/Features/Compile/CompileController.mjs',
    `    if (status === 'success') {\n      LocalProjectSyncManager.scheduleSync(projectId, {\n        compiledPdf: { buildId, userId },\n      })\n    }`,
    `    if (status === 'success') {\n      LocalProjectSyncManager.scheduleSync(projectId, {\n        direction: 'overleaf-to-host',\n        compiledPdf: { buildId, userId },\n      })\n    }`
  )

  // 7. Package Hub: Feature flag + ExpressLocals + router endpoints
  replaceExact(
    'app/src/infrastructure/Features.mjs',
    `      case 'track-changes':
        return trackChangesModuleAvailable
      default:`,
    `      case 'track-changes':
        return trackChangesModuleAvailable
      case 'package-hub':
        return (
          Settings.enablePackageHub !== false &&
          process.env.OVERLEAF_ENABLE_PACKAGE_HUB !== 'false'
        )
      default:`,
    "case 'package-hub':"
  )

  replaceExact(
    'app/src/infrastructure/ExpressLocals.mjs',
    `      enablePandocConversions: Settings.enablePandocConversions,`,
    `      enablePandocConversions: Settings.enablePandocConversions,
      hasPackageHubFeature: Features.hasFeature('package-hub'),`,
    'hasPackageHubFeature:'
  )

  replaceExact(
    'app/src/router.mjs',
    `import UserPagesController from './Features/User/UserPagesController.mjs'`,
    `import UserPagesController from './Features/User/UserPagesController.mjs'
import PackageHubController from './Features/PackageHub/PackageHubController.mjs'
import { multerErrorHandler } from './infrastructure/Multer.mjs'`,
    'PackageHubController'
  )

  replaceExact(
    'app/src/router.mjs',
    `  webRouter.get(
    '/user/settings',
    AuthenticationController.requireLogin(),
    PermissionsController.useCapabilities(),
    UserPagesController.settingsPage
  )`,
    `  webRouter.get(
    '/user/settings',
    AuthenticationController.requireLogin(),
    PermissionsController.useCapabilities(),
    UserPagesController.settingsPage
  )

  // Package Hub UI & API (same origin, session auth + CSRF)
  webRouter.get(
    '/packages',
    AuthenticationController.requireLogin(),
    PackageHubController.renderPackagesPage
  )
  webRouter.get(
    '/api/packages',
    AuthenticationController.requireLogin(),
    PackageHubController.listPackages
  )
  webRouter.get(
    '/api/packages/installed',
    AuthenticationController.requireLogin(),
    PackageHubController.listInstalled
  )
  webRouter.get(
    '/api/packages/search',
    AuthenticationController.requireLogin(),
    PackageHubController.searchPackages
  )
  webRouter.get(
    '/api/packages/updates',
    AuthenticationController.requireLogin(),
    PackageHubController.listUpdates
  )
  webRouter.get(
    '/api/packages/docs',
    AuthenticationController.requireLogin(),
    PackageHubController.getOpenApiDocs
  )
  webRouter.get(
    '/api/packages/audit',
    AuthenticationController.requireLogin(),
    PackageHubController.getAuditLog
  )
  webRouter.post(
    '/api/packages/install',
    AuthenticationController.requireLogin(),
    PackageHubController.installPackages
  )
  webRouter.post(
    '/api/packages/remove',
    AuthenticationController.requireLogin(),
    PackageHubController.removePackages
  )
  webRouter.post(
    '/api/packages/update',
    AuthenticationController.requireLogin(),
    PackageHubController.updatePackages
  )
  webRouter.post(
    '/api/packages/reconcile',
    AuthenticationController.requireLogin(),
    PackageHubController.reconcilePackages
  )
  webRouter.post(
    '/api/packages/snapshot',
    AuthenticationController.requireLogin(),
    PackageHubController.snapshotEnvironment
  )
  webRouter.post(
    '/api/packages/upload/validate',
    AuthenticationController.requireLogin(),
    PackageHubController.uploadMulterMiddleware,
    PackageHubController.validateUpload,
    multerErrorHandler
  )
  webRouter.post(
    '/api/packages/upload',
    AuthenticationController.requireLogin(),
    PackageHubController.uploadMulterMiddleware,
    PackageHubController.uploadPackage,
    multerErrorHandler
  )
  webRouter.delete(
    '/api/packages/custom/:name',
    AuthenticationController.requireLogin(),
    PackageHubController.deleteCustomPackage
  )
  webRouter.get(
    '/api/packages/jobs',
    AuthenticationController.requireLogin(),
    PackageHubController.listJobs
  )
  webRouter.get(
    '/api/packages/jobs/:jobId',
    AuthenticationController.requireLogin(),
    PackageHubController.getJob
  )
  webRouter.get(
    '/api/packages/jobs/:jobId/stream',
    AuthenticationController.requireLogin(),
    PackageHubController.streamJob
  )
  webRouter.get(
    '/api/packages/sources',
    AuthenticationController.requireLogin(),
    PackageHubController.getSources
  )
  webRouter.get(
    '/api/packages/sources/community',
    AuthenticationController.requireLogin(),
    PackageHubController.listCommunityManifests
  )
  webRouter.post(
    '/api/packages/sources/community',
    AuthenticationController.requireLogin(),
    PackageHubController.registerCommunityManifest
  )
  webRouter.post(
    '/api/packages/sources/texlive/mirror',
    AuthenticationController.requireLogin(),
    PackageHubController.setTexliveMirror
  )
  webRouter.get(
    '/api/packages/:name',
    AuthenticationController.requireLogin(),
    PackageHubController.getPackageDetails
  )
  webRouter.get(
    '/api/jobs',
    AuthenticationController.requireLogin(),
    PackageHubController.listJobs
  )
  webRouter.get(
    '/api/jobs/:jobId',
    AuthenticationController.requireLogin(),
    PackageHubController.getJob
  )
  webRouter.get(
    '/api/jobs/:jobId/stream',
    AuthenticationController.requireLogin(),
    PackageHubController.streamJob
  )
  webRouter.get(
    '/api/sources',
    AuthenticationController.requireLogin(),
    PackageHubController.getSources
  )
  webRouter.get(
    '/api/sources/community',
    AuthenticationController.requireLogin(),
    PackageHubController.listCommunityManifests
  )
  webRouter.post(
    '/api/sources/community',
    AuthenticationController.requireLogin(),
    PackageHubController.registerCommunityManifest
  )
  webRouter.post(
    '/api/sources/texlive/mirror',
    AuthenticationController.requireLogin(),
    PackageHubController.setTexliveMirror
  )`,
    "'/api/packages/install'"
  )

  replaceExact(
    'app/src/router.mjs',
    `  webRouter.get(
    '/api/packages/audit',
    AuthenticationController.requireLogin(),
    PackageHubController.getAuditLog
  )`,
    `  webRouter.get(
    '/api/packages/audit',
    AuthenticationController.requireLogin(),
    PackageHubController.getAuditLog
  )
  webRouter.post(
    '/api/packages/history/clear',
    AuthenticationController.requireLogin(),
    PackageHubController.clearHistory
  )`,
    "'/api/packages/history/clear'"
  )

  // 8. First-time setup (/launchpad), auto-routing, and account profile fields
  replaceExact(
    'modules/launchpad/app/src/LaunchpadController.mjs',
    `import Path from 'node:path'
import crypto from 'node:crypto'
import logger from '@overleaf/logger'
import UserRegistrationHandler from '../../../../app/src/Features/User/UserRegistrationHandler.mjs'
import EmailHandler from '../../../../app/src/Features/Email/EmailHandler.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import { User } from '../../../../app/src/models/User.mjs'
import AuthenticationManager from '../../../../app/src/Features/Authentication/AuthenticationManager.mjs'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import AdminAuthorizationHelper from '../../../../app/src/Features/Helpers/AdminAuthorizationHelper.mjs'
import { z, parseReq } from '../../../../app/src/infrastructure/Validation.mjs'`,
    `import Path from 'node:path'
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import logger from '@overleaf/logger'
import UserRegistrationHandler from '../../../../app/src/Features/User/UserRegistrationHandler.mjs'
import EmailHandler from '../../../../app/src/Features/Email/EmailHandler.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import UserSessionsManager from '../../../../app/src/Features/User/UserSessionsManager.mjs'
import { User } from '../../../../app/src/models/User.mjs'
import AuthenticationManager from '../../../../app/src/Features/Authentication/AuthenticationManager.mjs'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import AdminAuthorizationHelper from '../../../../app/src/Features/Helpers/AdminAuthorizationHelper.mjs'
import { sanitizeControlCharacters } from '../../../../app/src/infrastructure/Sanitize.mjs'
import { z, parseReq } from '../../../../app/src/infrastructure/Validation.mjs'`,
    'sanitizeControlCharacters'
  )

  replaceExact(
    'modules/launchpad/app/src/LaunchpadController.mjs',
    `  if (!sessionUser) {
    if (!adminUserExists) {
      res.render(Path.resolve(import.meta.dirname, '../views/launchpad'), {
        adminUserExists,
        authMethod,
      })
    } else {
      AuthenticationController.setRedirectInSession(req)
      res.redirect('/login')
    }
  } else {
    const user = await UserGetter.promises.getUser(sessionUser._id, {
      isAdmin: 1,
    })
    if (hasAdminAccess(user)) {
      res.render(Path.resolve(import.meta.dirname, '../views/launchpad'), {
        wsUrl: Settings.wsUrl,
        adminUserExists,
        authMethod,
      })
    } else {
      res.redirect('/restricted')
    }
  }`,
    `  if (!sessionUser) {
    if (!adminUserExists) {
      res.render(Path.resolve(import.meta.dirname, '../views/launchpad'), {
        adminUserExists,
        authMethod,
        defaultAdminEmailHint: (
          process.env.OVERLEAF_DEFAULT_ADMIN_EMAIL || ''
        ).trim(),
        showThinFooter: true,
      })
    } else {
      AuthenticationController.setRedirectInSession(req)
      res.redirect('/login')
    }
  } else {
    const user = await UserGetter.promises.getUser(sessionUser._id, {
      isAdmin: 1,
      email: 1,
      first_name: 1,
      last_name: 1,
      role: 1,
      institution: 1,
    })
    if (hasAdminAccess(user)) {
      res.render(Path.resolve(import.meta.dirname, '../views/launchpad'), {
        wsUrl: Settings.wsUrl,
        adminUserExists,
        authMethod,
        setupComplete: req.query?.setup === 'complete',
        currentAdmin: {
          email: user.email || '',
          first_name: user.first_name || '',
          last_name: user.last_name || '',
          role: user.role || '',
          institution: user.institution || '',
        },
        hasPackageHubFeature: Boolean(Settings.enablePackageHub),
        showThinFooter: true,
      })
    } else {
      res.redirect('/restricted')
    }
  }`,
    'defaultAdminEmailHint:'
  )

  replaceExact(
    'modules/launchpad/app/src/LaunchpadController.mjs',
    `const registerAdminSchema = z.object({
  body: z.strictObject({
    email: z.string().optional(),
    password: z.string().optional(),
  }),
})

async function registerAdmin(req, res) {
  const { body } = parseReq(req, registerAdminSchema, { logOnly: true })
  const { email, password } = body
  if (!email || !password) {
    logger.debug({}, 'must supply both email and password, disallow')
    return res.sendStatus(400)
  }

  logger.debug({ email }, 'attempted register first admin user')
  const exists = await _atLeastOneAdminExists()

  if (exists) {
    logger.debug({ email }, 'already have at least one admin user, disallow')
    return res.status(403).json({
      message: { type: 'error', text: 'admin user already exists' },
    })
  }

  const invalidEmail = AuthenticationManager.validateEmail(email)
  if (invalidEmail) {
    return res
      .status(400)
      .json({ message: { type: 'error', text: invalidEmail.message } })
  }

  const invalidPassword = AuthenticationManager.validatePassword(
    password,
    email
  )
  if (invalidPassword) {
    return res
      .status(400)
      .json({ message: { type: 'error', text: invalidPassword.message } })
  }

  const userDetails = { email, password, analyticsId: crypto.randomUUID() }

  const user =
    await UserRegistrationHandler.promises.registerNewUser(userDetails)

  logger.debug({ userId: user._id }, 'making user an admin')

  try {
    const reversedHostname = user.email
      .split('@')[1]
      .split('')
      .reverse()
      .join('')
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          isAdmin: true,
          emails: [{ email, reversedHostname }],
        },
      }
    ).exec()
  } catch (err) {
    OError.tag(err, 'error setting user to admin', {
      user_id: user._id,
    })
    throw err
  }

  logger.debug({ email, userId: user._id }, 'created first admin account')
  res.json({ redir: '/launchpad' })
}`,
    `export function splitFullName(rawFullName, rawFirstName, rawLastName) {
  const cleanFirst =
    typeof rawFirstName === 'string'
      ? sanitizeControlCharacters(rawFirstName).trim().slice(0, 255)
      : ''
  const cleanLast =
    typeof rawLastName === 'string'
      ? sanitizeControlCharacters(rawLastName).trim().slice(0, 255)
      : ''
  if (cleanFirst || cleanLast) {
    return { first_name: cleanFirst, last_name: cleanLast }
  }
  const cleanFull =
    typeof rawFullName === 'string'
      ? sanitizeControlCharacters(rawFullName).trim().slice(0, 255)
      : ''
  if (!cleanFull) {
    return { first_name: '', last_name: '' }
  }
  const idx = cleanFull.search(/\\s+/)
  if (idx === -1) {
    return { first_name: cleanFull, last_name: '' }
  }
  return {
    first_name: cleanFull.slice(0, idx).slice(0, 255),
    last_name: cleanFull.slice(idx).trim().slice(0, 255),
  }
}

async function loginNewlyCreatedAdmin(req, user) {
  const reqLogin = promisify((u, opts, cb) => req.login(u, opts, cb))
  const saveSession = promisify(cb => req.session.save(cb))
  await reqLogin(user, { keepSessionInfo: true })
  delete req.session.__tmp
  delete req.session.csrfSecret
  req.session.analyticsId = user.analyticsId
  await saveSession()
  UserSessionsManager.trackSession(user, req.sessionID, () => {})
}

export const registerAdminSchema = z.object({
  body: z.strictObject({
    email: z.string().trim().min(1).max(254).optional(),
    password: z.string().min(1).max(256).optional(),
    confirm_password: z.string().max(256).optional(),
    full_name: z.string().max(255).optional(),
    first_name: z.string().max(255).optional(),
    last_name: z.string().max(255).optional(),
    role: z.string().max(120).optional(),
    institution: z.string().max(160).optional(),
    _csrf: z.string().optional(),
  }),
})

async function registerAdmin(req, res) {
  let body
  try {
    ;({ body } = parseReq(req, registerAdminSchema))
  } catch {
    return res.status(400).json({
      message: { type: 'error', text: 'Invalid account details supplied' },
    })
  }
  const { email, password, confirm_password } = body
  if (!email || !password) {
    logger.debug({}, 'must supply both email and password, disallow')
    return res.status(400).json({
      message: {
        type: 'error',
        text: 'Please provide both an email address and password',
      },
    })
  }
  if (
    confirm_password != null &&
    confirm_password !== '' &&
    confirm_password !== password
  ) {
    return res.status(400).json({
      message: { type: 'error', text: 'Passwords do not match' },
    })
  }

  logger.debug({ email }, 'attempted register first admin user')
  const exists = await _atLeastOneAdminExists()

  if (exists) {
    logger.debug({ email }, 'already have at least one admin user, disallow')
    return res.status(403).json({
      message: { type: 'error', text: 'admin user already exists' },
    })
  }

  const invalidEmail = AuthenticationManager.validateEmail(email)
  if (invalidEmail) {
    return res
      .status(400)
      .json({ message: { type: 'error', text: invalidEmail.message } })
  }

  const invalidPassword = AuthenticationManager.validatePassword(
    password,
    email
  )
  if (invalidPassword) {
    return res
      .status(400)
      .json({ message: { type: 'error', text: invalidPassword.message } })
  }

  const parsedName = splitFullName(
    body.full_name,
    body.first_name,
    body.last_name
  )
  const role =
    typeof body.role === 'string'
      ? sanitizeControlCharacters(body.role).trim().slice(0, 120)
      : ''
  const institution =
    typeof body.institution === 'string'
      ? sanitizeControlCharacters(body.institution).trim().slice(0, 160)
      : ''

  const userDetails = {
    email,
    password,
    ...(parsedName.first_name ? { first_name: parsedName.first_name } : {}),
    ...(parsedName.last_name ? { last_name: parsedName.last_name } : {}),
    analyticsId: crypto.randomUUID(),
  }

  const user =
    await UserRegistrationHandler.promises.registerNewUser(userDetails)

  logger.debug({ userId: user._id }, 'making user an admin')

  try {
    const reversedHostname = user.email
      .split('@')[1]
      .split('')
      .reverse()
      .join('')
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          isAdmin: true,
          first_name: parsedName.first_name || user.first_name,
          last_name: parsedName.last_name || '',
          role,
          institution,
          emails: [{ email: user.email, reversedHostname }],
        },
      }
    ).exec()
  } catch (err) {
    OError.tag(err, 'error setting user to admin', {
      user_id: user._id,
    })
    throw err
  }

  try {
    const freshUser = await User.findById(user._id).exec()
    if (freshUser && typeof req.login === 'function') {
      await loginNewlyCreatedAdmin(req, freshUser)
    }
  } catch (err) {
    logger.warn({ err, userId: user._id }, 'auto-login after admin setup failed')
  }

  logger.debug({ email, userId: user._id }, 'created first admin account')
  res.json({ redir: '/launchpad?setup=complete' })
}`,
    'export function splitFullName'
  )

  replaceExact(
    'app/src/Features/StaticPages/HomeController.mjs',
    `import SplitTestHandler from '../SplitTests/SplitTestHandler.mjs'`,
    `import SplitTestHandler from '../SplitTests/SplitTestHandler.mjs'
import LaunchpadController from '../../../../modules/launchpad/app/src/LaunchpadController.mjs'`,
    'LaunchpadController'
  )

  replaceExact(
    'app/src/Features/StaticPages/HomeController.mjs',
    `  } else {
    res.redirect('/login')
  }`,
    `  } else {
    const adminExists = await LaunchpadController._atLeastOneAdminExists().catch(
      () => true
    )
    res.redirect(adminExists ? '/login' : '/launchpad')
  }`,
    "adminExists ? '/login' : '/launchpad'"
  )

  replaceExact(
    'app/src/Features/User/UserPagesController.mjs',
    `import SplitTestHandler from '../SplitTests/SplitTestHandler.mjs'`,
    `import SplitTestHandler from '../SplitTests/SplitTestHandler.mjs'
import LaunchpadController from '../../../../modules/launchpad/app/src/LaunchpadController.mjs'`,
    'LaunchpadController'
  )

  replaceExact(
    'app/src/Features/User/UserPagesController.mjs',
    `      first_name: user.first_name,
      last_name: user.last_name,`,
    `      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role || '',
      institution: user.institution || '',`,
    "institution: user.institution || ''"
  )

  replaceExact(
    'app/src/Features/User/UserPagesController.mjs',
    `const loginPageSchema = z.object({
  query: z.object({
    redir: z.string().optional(),
  }),
})`,
    `const loginPageSchema = z.object({
  query: z.object({
    redir: z.string().optional(),
    stay: z.string().optional(),
  }),
})`,
    'stay: z.string().optional()'
  )

  replaceExact(
    'app/src/Features/User/UserPagesController.mjs',
    `  loginPage(req, res) {
    const { query } = parseReq(req, loginPageSchema, { logOnly: true })

    // if user is being sent to /login with explicit redirect (redir=/foo),
    // such as being sent from the editor to /login, then set the redirect explicitly
    if (
      query.redir != null &&
      AuthenticationController.getRedirectFromSession(req) == null
    ) {
      AuthenticationController.setRedirectInSession(req, query.redir)
    }
    const metadata = { robotsNoindexNofollow: false }
    // any query param at all (not just \`redir\`) marks this page as noindex
    // -- e.g. error/SSO-flow flags added by other callers -- read the raw
    // query here rather than by name (case 1: verbatim forwarding)
    if (Object.keys(getRawReqInput(req).query).length !== 0) {
      metadata.robotsNoindexNofollow = true
    }
    res.render('user/login', {
      title: Settings.nav?.login_support_title || 'login',
      login_support_title: Settings.nav?.login_support_title,
      login_support_text: Settings.nav?.login_support_text,
      metadata,
    })
  },`,
    `  loginPage: expressify(async function loginPage(req, res) {
    if (SessionManager.isUserLoggedIn(req.session)) {
      return res.redirect(
        AuthenticationController.getRedirectFromSession(req) || '/project'
      )
    }
    const { query } = parseReq(req, loginPageSchema, { logOnly: true })

    const isSaas = Features.hasFeature('saas')
    let adminExists = true
    if (!isSaas) {
      adminExists = await LaunchpadController._atLeastOneAdminExists().catch(
        () => true
      )
      if (!adminExists && query.stay !== '1') {
        return res.redirect('/launchpad')
      }
    }

    // if user is being sent to /login with explicit redirect (redir=/foo),
    // such as being sent from the editor to /login, then set the redirect explicitly
    if (
      query.redir != null &&
      AuthenticationController.getRedirectFromSession(req) == null
    ) {
      AuthenticationController.setRedirectInSession(req, query.redir)
    }
    const metadata = { robotsNoindexNofollow: false }
    // any query param at all (not just \`redir\`) marks this page as noindex
    // -- e.g. error/SSO-flow flags added by other callers -- read the raw
    // query here rather than by name (case 1: verbatim forwarding)
    if (Object.keys(getRawReqInput(req).query).length !== 0) {
      metadata.robotsNoindexNofollow = true
    }
    res.render('user/login', {
      title: Settings.nav?.login_support_title || 'login',
      login_support_title: Settings.nav?.login_support_title,
      login_support_text: Settings.nav?.login_support_text,
      noAdminExists: !isSaas && !adminExists,
      showThinFooter: !isSaas,
      metadata,
    })
  }),`,
    'noAdminExists:'
  )

  replaceExact(
    'app/src/Features/User/UserController.mjs',
    `    role: z.string().optional(),
    institution: z.string().optional(),`,
    `    role: z.string().max(120).optional(),
    institution: z.string().max(160).optional(),`,
    'role: z.string().max(120).optional()'
  )

  removeExactIfPresent(
    'app/views/_mixins/ciam_mixins.pug',
    `\t\t.ciam-footer-ds-logo
\t\t\ta.ciam-image-link(
\t\t\t\thref='https://www.digital-science.com/'
\t\t\t\ttarget='_blank'
\t\t\t\trel='noopener noreferrer'
\t\t\t\tevent-tracking-mb='true'
\t\t\t\tevent-tracking='unified-access-footer-click'
\t\t\t\tevent-tracking-trigger='click'
\t\t\t\tevent-segmentation={
\t\t\t\t\tproduct: 'overleaf',
\t\t\t\t\titem: 'logo',
\t\t\t\t\tdestinationUrl: 'https://www.digital-science.com/',
\t\t\t\t}
\t\t\t)
\t\t\t\timg(
\t\t\t\t\tsrc=buildImgPath('digital-science/digital-science.svg')
\t\t\t\t\talt='Digital Science — home'
\t\t\t\t)\n`
  )

  replaceExact(
    'app/views/_mixins/ciam_mixins.pug',
    `\t\t\tif short
\t\t\t\t| !{translate('overleaf_is_a_ds_product')}`,
    `\t\t\tif short
\t\t\t\t| #{settings.appName}`,
    '#{settings.appName}'
  )

  removeExactIfPresent(
    'app/views/layout/fat-footer-base.pug',
    `\t\t\ta(href='https://www.digital-science.com/security-certifications/') #{translate('compliance')}\n`
  )
  removeExactIfPresent(
    'app/views/layout/fat-footer.pug',
    `\t\t\t\t\tli
\t\t\t\t\t\ta(href='https://digitalscience.pinpointhq.com/') #{translate('careers')}\n`
  )
  removeExactIfPresent(
    'app/views/layout/fat-footer-website-redesign.pug',
    `\t\t\t\t\tli
\t\t\t\t\t\ta(href='https://digitalscience.pinpointhq.com/') #{translate('careers')}\n`
  )

  copyStagedFile('app/views/user/login.pug')
  copyStagedFile('modules/launchpad/app/views/launchpad.pug')

  // 9. Enterprise Admin Console & SaaS route/link gating
  replaceExact(
    'app/views/layout-react.pug',
    `\t- const canDisplayProjectUrlLookup = settings.adminPrivilegeAvailable && canDisplayAdminMenu && hasAdminCapability('view-project-setting', false)`,
    `\t- const canDisplayProjectUrlLookup = hasFeature('saas') && settings.adminPrivilegeAvailable && canDisplayAdminMenu && hasAdminCapability('view-project-setting', false)`,
    "const canDisplayProjectUrlLookup = hasFeature('saas')"
  )

  replaceExact(
    'app/views/layout/navbar-marketing.pug',
    `\t\t- var canDisplayProjectUrlLookup = settings.adminPrivilegeAvailable && canDisplayAdminMenu && hasAdminCapability('view-project-setting', false)`,
    `\t\t- var canDisplayProjectUrlLookup = hasFeature('saas') && settings.adminPrivilegeAvailable && canDisplayAdminMenu && hasAdminCapability('view-project-setting', false)`,
    "var canDisplayProjectUrlLookup = hasFeature('saas')"
  )

  replaceExact(
    'app/views/layout/navbar-marketing.pug',
    `\t\t\t\t\t\t\t\tif canDisplayAdminMenu
\t\t\t\t\t\t\t\t\t+dropdown-menu-link-item(href='/admin') Manage Site
\t\t\t\t\t\t\t\t\t+dropdown-menu-link-item(href='/admin/user') Manage Users`,
    `\t\t\t\t\t\t\t\tif canDisplayAdminMenu
\t\t\t\t\t\t\t\t\t+dropdown-menu-link-item(href='/admin') System Admin
\t\t\t\t\t\t\t\t\t+dropdown-menu-link-item(href='/admin/user') Manage Users
\t\t\t\t\t\t\t\t\tif hasFeature('package-hub')
\t\t\t\t\t\t\t\t\t\t+dropdown-menu-link-item(href='/packages') Manage Packages`,
    "+dropdown-menu-link-item(href='/admin') System Admin"
  )

  removeExactIfPresent(
    'modules/user-activate/app/src/UserActivateRouter.mjs',
    `    webRouter.get(
      '/admin/user',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      (req, res) => res.redirect('/admin/register')
    )\n\n`
  )

  replaceExact(
    'modules/user-activate/app/src/UserActivateController.mjs',
    `import ErrorController from '../../../../app/src/Features/Errors/ErrorController.mjs'`,
    `import AuthenticationManager from '../../../../app/src/Features/Authentication/AuthenticationManager.mjs'
import ErrorController from '../../../../app/src/Features/Errors/ErrorController.mjs'`,
    'AuthenticationManager'
  )

  replaceExact(
    'modules/user-activate/app/src/UserActivateController.mjs',
    `const registerSchema = z.object({
  body: z.strictObject({
    email: z.string().optional(),
  }),
})

function registerNewUser(req, res, next) {
  res.render(Path.resolve(__dirname, '../views/user/register'))
}

async function register(req, res, next) {
  const { body } = parseReq(req, registerSchema, { logOnly: true })
  const { email } = body
  if (email == null || email === '') {
    return res.sendStatus(422) // Unprocessable Entity
  }
  const { user, setNewPasswordUrl } =
    await UserRegistrationHandler.promises.registerNewUserAndSendActivationEmail(
      email
    )
  res.json({
    email: user.email,
    setNewPasswordUrl,
  })
}`,
    `const registerSchema = z.object({
  body: z.strictObject({
    email: z.string().optional(),
    _csrf: z.string().optional(),
  }),
})

function registerNewUser(req, res) {
  res.render(Path.resolve(__dirname, '../views/user/register'), {
    title: 'Register Users',
    showThinFooter: true,
  })
}

async function register(req, res) {
  const { body } = parseReq(req, registerSchema, { logOnly: true })
  const email = typeof body.email === 'string' ? body.email.trim() : ''
  if (!email) {
    return res.status(422).json({ message: 'Email address is required' })
  }
  const invalidEmail = AuthenticationManager.validateEmail(email)
  if (invalidEmail) {
    return res
      .status(400)
      .json({ message: invalidEmail.message || 'Invalid email address' })
  }
  const { user, setNewPasswordUrl } =
    await UserRegistrationHandler.promises.registerNewUserAndSendActivationEmail(
      email
    )
  res.json({
    email: user.email,
    setNewPasswordUrl,
  })
}`,
    '_csrf: z.string().optional()'
  )

  replaceExact(
    'app/src/router.mjs',
    `  webRouter.get(
    '/admin',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.index
  )

  if (!Features.hasFeature('saas')) {
    webRouter.post(
      '/admin/openEditor',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminController.openEditor
    )
    webRouter.post(
      '/admin/closeEditor',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminController.closeEditor
    )
    webRouter.post(
      '/admin/disconnectAllUsers',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminController.disconnectAllUsers
    )
  }
  webRouter.post(
    '/admin/flushProjectToTpds',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.flushProjectToTpds
  )
  webRouter.post(
    '/admin/pollDropboxForUser',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.pollDropboxForUser
  )
  webRouter.post(
    '/admin/messages',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.createMessage
  )
  webRouter.post(
    '/admin/messages/clear',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.clearMessages
  )`,
    `  webRouter.get(
    '/admin',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.index
  )
  webRouter.get(
    '/admin/user',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.usersPage
  )

  webRouter.get(
    '/api/admin/overview',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.getOverview
  )
  webRouter.post(
    '/api/admin/editor',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.setEditorStatus
  )
  webRouter.post(
    '/api/admin/disconnect-all',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.disconnectAllUsersJson
  )
  webRouter.post(
    '/api/admin/messages',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.createMessageJson
  )
  webRouter.delete(
    '/api/admin/messages/:messageId',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.deleteMessageJson
  )
  webRouter.post(
    '/api/admin/messages/clear',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.clearMessagesJson
  )
  webRouter.get(
    '/api/admin/users',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.listUsers
  )
  webRouter.post(
    '/api/admin/users',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.createUser
  )
  webRouter.patch(
    '/api/admin/users/:userId',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.updateUser
  )
  webRouter.post(
    '/api/admin/users/:userId/reset-link',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.generateResetLink
  )
  webRouter.delete(
    '/api/admin/users/:userId',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.deleteUser
  )

  if (!Features.hasFeature('saas')) {
    webRouter.post(
      '/admin/openEditor',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminController.openEditor
    )
    webRouter.post(
      '/admin/closeEditor',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminController.closeEditor
    )
    webRouter.post(
      '/admin/disconnectAllUsers',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminController.disconnectAllUsers
    )
  } else {
    webRouter.post(
      '/admin/flushProjectToTpds',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminController.flushProjectToTpds
    )
    webRouter.post(
      '/admin/pollDropboxForUser',
      AuthorizationMiddleware.ensureUserIsSiteAdmin,
      AdminController.pollDropboxForUser
    )
  }
  webRouter.post(
    '/admin/messages',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.createMessage
  )
  webRouter.post(
    '/admin/messages/clear',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.clearMessages
  )`,
    "'/api/admin/overview'"
  )

  copyStagedFile('app/src/Features/ServerAdmin/WorkspaceBrandingService.mjs')
  copyStagedFile('app/src/Features/ServerAdmin/AdminService.mjs')
  copyStagedFile('app/src/Features/ServerAdmin/AdminController.mjs')
  copyStagedFile('app/views/admin/index.pug')
  copyStagedFile('app/views/layout/thin-footer.pug')
  copyStagedFile('config/settings.defaults.js')

  // Enterprise Project Access & User-to-User Sharing
  copyStagedFile('app/src/Features/Authorization/ProjectAccessPolicyService.mjs')
  copyStagedFile('app/src/Features/Authorization/ProjectSharingController.mjs')

  replaceExact(
    'app/src/models/Project.mjs',
    `    localFolderFileCount: { type: Number },
    localFolderHasPdf: { type: Boolean, default: false },`,
    `    localFolderFileCount: { type: Number },
    localFolderHasPdf: { type: Boolean, default: false },
    copyDisabled_refs: [{ type: ObjectId, ref: 'User' }],
    enterpriseAccess: {
      scope: {
        type: String,
        enum: ['private', 'network', 'all_users', 'custom'],
        default: 'private',
      },
      privilegeLevel: {
        type: String,
        enum: ['readOnly', 'readAndWrite'],
        default: 'readOnly',
      },
      allowCopy: { type: Boolean, default: true },
      networkOnly: { type: Boolean, default: false },
      allowedCidrs: [{ type: String }],
      targetRoles: [{ type: String }],
      targetInstitutions: [{ type: String }],
      targetUserIds: [{ type: ObjectId, ref: 'User' }],
      updatedBy: { type: ObjectId, ref: 'User' },
      updatedAt: { type: Date },
    },`,
    'enterpriseAccess:'
  )

  replaceExact(
    'app/src/Features/Authorization/AuthorizationManager.mjs',
    `import ChatApiHandler from '../Chat/ChatApiHandler.mjs'`,
    `import ChatApiHandler from '../Chat/ChatApiHandler.mjs'
import ProjectAccessPolicyService from './ProjectAccessPolicyService.mjs'`,
    'ProjectAccessPolicyService'
  )

  replaceExact(
    'app/src/Features/Authorization/AuthorizationManager.mjs',
    `  const privilegeLevel = projectAccess.privilegeLevelForUser(userId)
  if (privilegeLevel && privilegeLevel !== PrivilegeLevels.NONE) {
    // The user has direct access
    return privilegeLevel
  }`,
    `  const enterprisePolicy =
    await ProjectAccessPolicyService.evaluateEnterpriseAccessForUserById(
      userId,
      projectId
    )

  const privilegeLevel = projectAccess.privilegeLevelForUser(userId)
  if (privilegeLevel && privilegeLevel !== PrivilegeLevels.NONE) {
    if (
      privilegeLevel !== PrivilegeLevels.OWNER &&
      enterprisePolicy.granted &&
      enterprisePolicy.privilegeLevel === PrivilegeLevels.READ_AND_WRITE
    ) {
      return PrivilegeLevels.READ_AND_WRITE
    }
    return privilegeLevel
  }

  if (enterprisePolicy.granted && enterprisePolicy.privilegeLevel) {
    return enterprisePolicy.privilegeLevel
  }`,
    'evaluateEnterpriseAccessForUserById'
  )

  replaceExact(
    'app/src/Features/Project/ProjectController.mjs',
    `import ProjectAuditLogHandler from './ProjectAuditLogHandler.mjs'`,
    `import ProjectAuditLogHandler from './ProjectAuditLogHandler.mjs'
import ProjectAccessPolicyService from '../Authorization/ProjectAccessPolicyService.mjs'
import LocalProjectSyncManager from './LocalProjectSyncManager.mjs'`,
    'ProjectAccessPolicyService'
  )

  replaceExact(
    'app/src/Features/Project/ProjectController.mjs',
    `      await Promise.all([
        InactiveProjectManager.promises.reactivateProjectIfRequired(project),
        TpdsProjectFlusher.promises.flushProjectToTpdsIfNeeded(project),
      ])`,
    `      await Promise.all([
        InactiveProjectManager.promises.reactivateProjectIfRequired(project),
        TpdsProjectFlusher.promises.flushProjectToTpdsIfNeeded(project),
      ])

      if (
        LocalProjectSyncManager &&
        typeof LocalProjectSyncManager.syncFromLocalFolderIfChanged === 'function'
      ) {
        try {
          await LocalProjectSyncManager.syncFromLocalFolderIfChanged(projectId, {
            userId,
          })
        } catch (syncErr) {
          logger.warn(
            { err: syncErr, projectId },
            'local-sync: loadEditor sync check failed'
          )
        }
      }`,
    'syncFromLocalFolderIfChanged'
  )

  replaceExact(
    'app/src/Features/Project/ProjectController.mjs',
    `    if (!SessionManager.isUserLoggedIn(req.session)) {
      return res.json({ redir: '/register' })
    }
    const { first_name: firstName, last_name: lastName, email } = currentUser`,
    `    if (!SessionManager.isUserLoggedIn(req.session)) {
      return res.json({ redir: '/register' })
    }
    const canCopy = await ProjectAccessPolicyService.canUserCopyProject(
      currentUser._id,
      projectId
    )
    if (!canCopy) {
      return res.status(403).json({
        message: 'Copying this shared project is disabled by its sharing permissions.',
      })
    }
    const { first_name: firstName, last_name: lastName, email } = currentUser`,
    'canUserCopyProject'
  )

  replaceExact(
    'app/src/Features/Project/ProjectListController.mjs',
    `import LocalProjectSyncManager from './LocalProjectSyncManager.mjs'`,
    `import LocalProjectSyncManager from './LocalProjectSyncManager.mjs'
import ProjectAccessPolicyService from '../Authorization/ProjectAccessPolicyService.mjs'`,
    'ProjectAccessPolicyService'
  )

  replaceExact(
    'app/src/Features/Project/ProjectListController.mjs',
    `  const results = await Promise.all([
    ProjectGetter.promises.findAllUsersProjects(
      userId,
      'name lastUpdated lastUpdatedBy publicAccesLevel archived trashed owner_ref tokens localFolderPath localFolderSyncEnabled localFolderLastSyncedAt localFolderLastSyncStatus localFolderLastSyncError localFolderLastSyncedPath localFolderFileCount localFolderHasPdf'
    ),
    TagsHandler.promises.getAllTags(userId),
  ])
  const [allProjects, tags] = results
  const formattedProjects = _formatProjects(allProjects, userId)`,
    `  const projectListFields =
    'name lastUpdated lastUpdatedBy publicAccesLevel archived trashed owner_ref tokens collaberator_refs reviewer_refs readOnly_refs copyDisabled_refs enterpriseAccess localFolderPath localFolderSyncEnabled localFolderLastSyncedAt localFolderLastSyncStatus localFolderLastSyncError localFolderLastSyncedPath localFolderFileCount localFolderHasPdf'
  const results = await Promise.all([
    ProjectGetter.promises.findAllUsersProjects(userId, projectListFields),
    TagsHandler.promises.getAllTags(userId),
    ProjectAccessPolicyService.findEnterpriseSharedProjectsForUser(
      userId,
      projectListFields
    ),
  ])
  const [allProjects, tags, enterpriseShared] = results
  const existingProjectIds = new Set(
    [
      ...(allProjects.owned || []),
      ...(allProjects.readAndWrite || []),
      ...(allProjects.review || []),
      ...(allProjects.readOnly || []),
      ...(allProjects.tokenReadAndWrite || []),
      ...(allProjects.tokenReadOnly || []),
    ].map(p => String(p._id))
  )
  for (const p of enterpriseShared.readAndWrite || []) {
    if (!existingProjectIds.has(String(p._id))) {
      existingProjectIds.add(String(p._id))
      allProjects.readAndWrite = [...(allProjects.readAndWrite || []), p]
    }
  }
  for (const p of enterpriseShared.readOnly || []) {
    if (!existingProjectIds.has(String(p._id))) {
      existingProjectIds.add(String(p._id))
      allProjects.readOnly = [...(allProjects.readOnly || []), p]
    }
  }
  const formattedProjects = _formatProjects(allProjects, userId)`,
    'findEnterpriseSharedProjectsForUser'
  )

  replaceExact(
    'app/src/Features/Project/ProjectListController.mjs',
    `  const localFolderMap = await LocalProjectSyncManager.buildProjectFolderInfoMap(
    userId,
    uniqueRawProjects
  )
  for (const proj of projects) {
    proj.localFolder = localFolderMap.get(proj.id)
  }`,
    `  const [localFolderMap, sharingInfoMap] = await Promise.all([
    LocalProjectSyncManager.buildProjectFolderInfoMap(
      userId,
      uniqueRawProjects
    ),
    Promise.resolve(
      ProjectAccessPolicyService.buildProjectSharingInfoMap(
        userId,
        uniqueRawProjects,
        enterpriseShared.policyInfoById
      )
    ),
  ])
  for (const proj of projects) {
    proj.localFolder = localFolderMap.get(proj.id)
    proj.sharingInfo = sharingInfoMap.get(proj.id)
  }`,
    'buildProjectSharingInfoMap'
  )

  replaceExact(
    'app/src/router.mjs',
    `import AsyncLocalStorage from './infrastructure/AsyncLocalStorage.mjs'`,
    `import AsyncLocalStorage from './infrastructure/AsyncLocalStorage.mjs'
import ProjectAccessPolicyService from './Features/Authorization/ProjectAccessPolicyService.mjs'
import ProjectSharingController from './Features/Authorization/ProjectSharingController.mjs'`,
    'ProjectSharingController'
  )

  replaceExact(
    'app/src/router.mjs',
    `async function initialize(webRouter, privateApiRouter, publicApiRouter) {
  webRouter.use(unsupportedBrowserMiddleware)`,
    `async function initialize(webRouter, privateApiRouter, publicApiRouter) {
  webRouter.use(unsupportedBrowserMiddleware)
  webRouter.use(ProjectAccessPolicyService.requestContextMiddleware)`,
    'ProjectAccessPolicyService.requestContextMiddleware'
  )

  replaceExact(
    'app/src/router.mjs',
    `  webRouter.get(
    '/admin/user',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.usersPage
  )`,
    `  webRouter.get(
    '/admin/user',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.usersPage
  )
  webRouter.get(
    '/admin/projects',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.projectsPage
  )

  webRouter.get(
    '/api/projects/:Project_id/sharing',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanReadProject,
    ProjectSharingController.getProjectSharing
  )
  webRouter.get(
    '/api/projects/:Project_id/sharing/user-search',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanAdminProject,
    ProjectSharingController.searchUsers
  )
  webRouter.post(
    '/api/projects/:Project_id/sharing/collaborators',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanAdminProject,
    ProjectSharingController.addCollaborator
  )
  webRouter.patch(
    '/api/projects/:Project_id/sharing/collaborators/:userId',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanAdminProject,
    ProjectSharingController.updateCollaborator
  )
  webRouter.delete(
    '/api/projects/:Project_id/sharing/collaborators/:userId',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanAdminProject,
    ProjectSharingController.removeCollaborator
  )`,
    'ProjectSharingController.getProjectSharing'
  )

  replaceExact(
    'app/src/router.mjs',
    `  webRouter.delete(
    '/api/admin/users/:userId',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.deleteUser
  )`,
    `  webRouter.delete(
    '/api/admin/users/:userId',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.deleteUser
  )
  webRouter.get(
    '/api/admin/projects',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.listProjects
  )
  webRouter.get(
    '/api/admin/projects/:projectId/access',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.getProjectAccess
  )
  webRouter.put(
    '/api/admin/projects/:projectId/access',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.updateProjectAccess
  )
  webRouter.post(
    '/api/admin/projects/:projectId/collaborators',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.addProjectCollaborator
  )
  webRouter.patch(
    '/api/admin/projects/:projectId/collaborators/:userId',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.updateProjectCollaborator
  )
  webRouter.delete(
    '/api/admin/projects/:projectId/collaborators/:userId',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.removeProjectCollaborator
  )`,
    "'/api/admin/projects'"
  )

  replaceExact(
    'app/src/router.mjs',
    `  webRouter.get(
    '/api/projects/:Project_id/sharing',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanAdminProject,
    ProjectSharingController.getProjectSharing
  )`,
    `  webRouter.get(
    '/api/projects/:Project_id/sharing',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanReadProject,
    ProjectSharingController.getProjectSharing
  )`,
    `  webRouter.get(
    '/api/projects/:Project_id/sharing',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanReadProject`
  )

  replaceExact(
    'app/src/router.mjs',
    `  webRouter.get(
    '/api/admin/projects',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.listProjects
  )
  webRouter.put(`,
    `  webRouter.get(
    '/api/admin/projects',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.listProjects
  )
  webRouter.get(
    '/api/admin/projects/:projectId/access',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.getProjectAccess
  )
  webRouter.put(`,
    'AdminController.getProjectAccess'
  )

  // Unified native Overleaf sharing backend (directory contacts, instant workspace collaboration, allowCopy propagation)
  copyStagedFile('app/src/Features/Contacts/ContactController.mjs')
  copyStagedFile('app/src/Features/Collaborators/CollaboratorsGetter.mjs')
  copyStagedFile('app/src/Features/Collaborators/CollaboratorsInviteController.mjs')
  copyStagedFile('app/src/Features/Collaborators/CollaboratorsController.mjs')
  copyStagedFile('app/src/Features/Project/ProjectEditorHandler.mjs')
  copyStagedFile('app/src/Features/Editor/EditorHttpController.mjs')

  // Custom Organization Logo routes, ExpressLocals propagation, and network-wide templates
  replaceExact(
    'app/src/router.mjs',
    `  webRouter.delete(
    '/api/admin/projects/:projectId/collaborators/:userId',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.removeProjectCollaborator
  )`,
    `  webRouter.delete(
    '/api/admin/projects/:projectId/collaborators/:userId',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.removeProjectCollaborator
  )
  webRouter.get('/api/branding/logo', AdminController.getPublicLogo)
  webRouter.get('/api/branding/logo-dark', AdminController.getPublicLogo)
  AuthenticationController.addEndpointToLoginWhitelist('/api/branding/logo')
  AuthenticationController.addEndpointToLoginWhitelist('/api/branding/logo-dark')
  webRouter.get(
    '/api/admin/branding',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.getBranding
  )
  webRouter.put(
    '/api/admin/branding',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.updateBranding
  )
  webRouter.delete(
    '/api/admin/branding',
    AuthorizationMiddleware.ensureUserIsSiteAdmin,
    AdminController.resetBranding
  )`,
    "'/api/admin/branding'"
  )

  replaceIfPresent(
    'app/src/router.mjs',
    `  webRouter.get('/api/branding/logo', AdminController.getPublicLogo)
  webRouter.get('/api/branding/logo-dark', AdminController.getPublicLogo)
  webRouter.get(
    '/api/admin/branding',`,
    `  webRouter.get('/api/branding/logo', AdminController.getPublicLogo)
  webRouter.get('/api/branding/logo-dark', AdminController.getPublicLogo)
  AuthenticationController.addEndpointToLoginWhitelist('/api/branding/logo')
  AuthenticationController.addEndpointToLoginWhitelist('/api/branding/logo-dark')
  webRouter.get(
    '/api/admin/branding',`
  )

  replaceExact(
    'app/src/infrastructure/ExpressLocals.mjs',
    `import AdminAuthorizationHelper from '../Features/Helpers/AdminAuthorizationHelper.mjs'`,
    `import AdminAuthorizationHelper from '../Features/Helpers/AdminAuthorizationHelper.mjs'
import WorkspaceBrandingService from '../Features/ServerAdmin/WorkspaceBrandingService.mjs'`,
    'WorkspaceBrandingService'
  )

  replaceExact(
    'app/src/infrastructure/ExpressLocals.mjs',
    `  webRouter.use(function (req, res, next) {
    res.locals.session = req.session`,
    `  WorkspaceBrandingService.initialize().catch(err => {
    logger.warn({ err }, 'failed to initialize workspace branding cache')
  })

  webRouter.use(function (req, res, next) {
    res.locals.session = req.session
    res.locals.workspaceBranding = WorkspaceBrandingService.getCachedSummary()`,
    'res.locals.workspaceBranding ='
  )

  replaceExact(
    'app/views/layout-react.pug',
    `\t\tcontent={
\t\t\tcustomLogo: settings.nav.custom_logo_light || settings.nav.custom_logo,
\t\t\tcustomLogoDark: settings.nav.custom_logo_dark || settings.nav.custom_logo,
\t\t\ttitle: nav.title,`,
    `\t\tcontent={
\t\t\tcustomLogo: (workspaceBranding && workspaceBranding.logoUrl) || settings.nav.custom_logo_light || settings.nav.custom_logo,
\t\t\tcustomLogoDark: (workspaceBranding && (workspaceBranding.logoDarkUrl || workspaceBranding.logoUrl)) || settings.nav.custom_logo_dark || settings.nav.custom_logo,
\t\t\torganizationName: (workspaceBranding && workspaceBranding.organizationName) || undefined,
\t\t\ttitle: nav.title,`,
    'workspaceBranding && workspaceBranding.logoUrl'
  )

  replaceExact(
    'app/views/layout/navbar-marketing.pug',
    `\t\t\t- var customLogo = settings.nav.custom_logo_light || settings.nav.custom_logo
\t\t\ta.navbar-brand(href='/' aria-label=settings.appName)
\t\t\t\tif customLogo
\t\t\t\t\t.navbar-logo(style=\`background-image:url("\${customLogo}")\`)
\t\t\t\tif nav.title
\t\t\t\t\t.navbar-title #{nav.title}
\t\t\t\tif !nav.title && !customLogo
\t\t\t\t\t.navbar-logo`,
    `\t\t\t- var legacyTitles = ['Our Overleaf Instance', 'Overleaf Community Edition', 'Overleaf (Community Edition)']
\t\t\t- var customLogo = (workspaceBranding && workspaceBranding.logoUrl) || settings.nav.custom_logo_light || settings.nav.custom_logo
\t\t\t- var brandLabel = (workspaceBranding && workspaceBranding.organizationName) || (settings.appName && !legacyTitles.includes(String(settings.appName).trim()) ? settings.appName : 'Overleaf')
\t\t\t- var defaultLogoUrl = customLogo || buildImgPath(isWebsiteRedesign ? '/ol-brand/overleaf-green.svg' : '/ol-brand/overleaf-white.svg')
\t\t\ta.navbar-brand(href='/' aria-label=brandLabel)
\t\t\t\t.navbar-logo(style=\`background-image:url("\${defaultLogoUrl}")\`)`,
    'var legacyTitles ='
  )

  replaceIfPresent(
    'app/views/layout/navbar-marketing.pug',
    `\t\t\t\tif customLogo || !effectiveTitle
\t\t\t\t\t.navbar-logo(style=\`background-image:url("\${defaultLogoUrl}")\`)
\t\t\t\tif effectiveTitle
\t\t\t\t\t.navbar-title #{effectiveTitle}`,
    `\t\t\t\t.navbar-logo(style=\`background-image:url("\${defaultLogoUrl}")\`)`
  )

  // 11. Cloud ZIP (< 30 MB) export backend
  copyStagedFile('app/src/Features/Downloads/ProjectCloudExportManager.mjs')
  copyStagedFile('app/src/Features/Downloads/cloud_zip_optimize.py')

  replaceExact(
    'app/src/Features/Downloads/ProjectDownloadsController.mjs',
    `import ProjectZipStreamManager from './ProjectZipStreamManager.mjs'`,
    `import fs from 'node:fs'
import ProjectZipStreamManager from './ProjectZipStreamManager.mjs'
import ProjectCloudExportManager from './ProjectCloudExportManager.mjs'`,
    'ProjectCloudExportManager'
  )

  replaceExact(
    'app/src/Features/Downloads/ProjectDownloadsController.mjs',
    `const downloadProjectParamsSchema = z.object({
  params: z.strictObject({
    Project_id: zz.objectId(),
  }),
})`,
    `const downloadProjectParamsSchema = z.object({
  params: z.strictObject({
    Project_id: zz.objectId(),
  }),
})

const prepareCloudZipSchema = z.object({
  params: z.strictObject({
    Project_id: zz.objectId(),
  }),
  body: z
    .object({
      targetMaxMb: z.coerce.number().min(5).max(30).optional().default(25),
      compressImages: z.boolean().optional().default(true),
      pruneUnused: z.boolean().optional().default(true),
    })
    .optional()
    .default({}),
})

const downloadCloudZipFileSchema = z.object({
  params: z.strictObject({
    Project_id: zz.objectId(),
    jobId: z.uuid(),
  }),
})`,
    'prepareCloudZipSchema'
  )

  replaceExact(
    'app/src/Features/Downloads/ProjectDownloadsController.mjs',
    `                prepareZipAttachment(
                  res,
                  \`Overleaf Projects (\${projectIds.length} items).zip\`
                )
                stream.pipe(res)
              }
            )
          }
        )
      }
    )
  },
}`,
    `                prepareZipAttachment(
                  res,
                  \`Overleaf Projects (\${projectIds.length} items).zip\`
                )
                stream.pipe(res)
              }
            )
          }
        )
      }
    )
  },

  prepareCloudZip: expressify(async (req, res) => {
    const userId = SessionManager.getLoggedInUserId(req.session)
    const { params, body } = parseReq(req, prepareCloudZipSchema)
    const projectId = params.Project_id
    Metrics.inc('zip-downloads-cloud-prepare')
    try {
      const result = await ProjectCloudExportManager.createCloudZipJob(
        projectId,
        userId,
        body
      )
      ProjectAuditLogHandler.addEntryInBackground(
        projectId,
        'project-downloaded',
        userId,
        req.ip
      )
      res.json(result)
    } catch (err) {
      const status = err?.statusCode || 500
      res.status(status).json({
        ok: false,
        error: err?.message || 'Failed preparing Cloud ZIP export',
      })
    }
  }),

  downloadCloudZipFile: expressify(async (req, res) => {
    const userId = SessionManager.getLoggedInUserId(req.session)
    const { params } = parseReq(req, downloadCloudZipFileSchema)
    const { Project_id: projectId, jobId } = params
    const job = ProjectCloudExportManager.consumeCloudZipJob(
      jobId,
      projectId,
      userId
    )
    if (!job) {
      return res.status(404).json({
        ok: false,
        error: 'Cloud ZIP export has expired or was not found. Please rebuild it.',
      })
    }
    Metrics.inc('zip-downloads-cloud-file')
    prepareZipAttachment(res, job.filename)
    try {
      const stat = fs.statSync(job.zipPath)
      res.setHeader('Content-Length', String(stat.size))
    } catch {}
    const stream = fs.createReadStream(job.zipPath)
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      ProjectCloudExportManager.cleanupJobFiles(job)
    }
    res.on('close', cleanup)
    stream.on('error', err => {
      cleanup()
      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error: err?.message || 'Cloud ZIP stream failed',
        })
      }
    })
    stream.pipe(res)
  }),
}`,
    'prepareCloudZip:'
  )

  replaceExact(
    'app/src/router.mjs',
    `  webRouter.get(
    '/project/download/zip',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.multipleProjectsZipDownload),
    AuthorizationMiddleware.ensureUserCanReadMultipleProjects,
    ProjectDownloadsController.downloadMultipleProjects
  )`,
    `  webRouter.get(
    '/project/download/zip',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.multipleProjectsZipDownload),
    AuthorizationMiddleware.ensureUserCanReadMultipleProjects,
    ProjectDownloadsController.downloadMultipleProjects
  )
  webRouter.post(
    '/project/:Project_id/download/cloud-zip',
    AuthenticationController.requireLogin(),
    RateLimiterMiddleware.rateLimit(rateLimiters.zipDownload, {
      params: ['Project_id'],
    }),
    AuthorizationMiddleware.ensureUserCanReadProject,
    ProjectDownloadsController.prepareCloudZip
  )
  webRouter.get(
    '/project/:Project_id/download/cloud-zip/:jobId',
    AuthenticationController.requireLogin(),
    AuthorizationMiddleware.ensureUserCanReadProject,
    ProjectDownloadsController.downloadCloudZipFile
  )`,
    'downloadCloudZipFile'
  )
}

function applyFrontendPatches() {
  // 1. Dashboard API types
  replaceExact(
    'types/project/dashboard/api.d.ts',
    `export type ProjectApi = {
  id: string
  name: string
  owner?: UserRef
  lastUpdated: Date
  lastUpdatedBy: UserRef | null
  archived: boolean
  trashed: boolean
  accessLevel: ProjectAccessLevel
  source: Source
}`,
    `export type ProjectLocalFolderInfo = {
  customPath: string | null
  effectivePath: string
  isCustom: boolean
  syncEnabled: boolean
  lastSyncedAt: string | null
  lastSyncedPath: string | null
  status: 'synced' | 'error' | 'disabled' | 'not_synced'
  error: string | null
  fileCount: number | null
  hasPdf: boolean
}

export type LocalSyncSettings = {
  baseDir: string
  defaultBaseDir: string
  allowedRoot: string
  serviceHealthy: boolean
  presets: string[]
  daemonUid?: number | null
}

export type ProjectApi = {
  id: string
  name: string
  owner?: UserRef
  lastUpdated: Date
  lastUpdatedBy: UserRef | null
  archived: boolean
  trashed: boolean
  accessLevel: ProjectAccessLevel
  source: Source
  localFolder?: ProjectLocalFolderInfo
}`,
    'ProjectLocalFolderInfo'
  )

  // 2. project-list util/api.ts
  replaceExact(
    'frontend/js/features/project-list/util/api.ts',
    `import {
  GetProjectsResponseBody,
  Sort,
} from '../../../../../types/project/dashboard/api'
import { deleteJSON, postJSON } from '../../../infrastructure/fetch-json'`,
    `import {
  GetProjectsResponseBody,
  LocalSyncSettings,
  ProjectLocalFolderInfo,
  Sort,
} from '../../../../../types/project/dashboard/api'
import {
  deleteJSON,
  getJSON,
  postJSON,
} from '../../../infrastructure/fetch-json'`,
    'LocalSyncSettings'
  )

  replaceExact(
    'frontend/js/features/project-list/util/api.ts',
    `export function untrashProject(projectId: string) {
  return deleteJSON(\`/project/\${projectId}/trash\`)
}`,
    `export function untrashProject(projectId: string) {
  return deleteJSON(\`/project/\${projectId}/trash\`)
}

export type BrowseDirectoriesResponse = {
  ok: boolean
  currentPath: string
  parentPath: string | null
  allowedRoot: string
  defaultBaseDir: string
  directories: Array<{ name: string; path: string }>
}

export function getLocalSyncSettings(): Promise<LocalSyncSettings> {
  return getJSON('/api/local-sync/settings')
}

export function updateLocalSyncBaseDir(body: {
  baseDir: string
  syncAll?: boolean
  cleanOld?: boolean
}): Promise<{
  settings: LocalSyncSettings
  previousBaseDir: string
  syncedCount: number
  failedCount: number
}> {
  return postJSON('/api/local-sync/settings', { body })
}

export function syncAllLocalProjects(): Promise<{
  ok: boolean
  total: number
  syncedCount: number
  failedCount: number
}> {
  return postJSON('/api/local-sync/sync-all')
}

export function browseLocalDirectories(
  dirPath?: string
): Promise<BrowseDirectoriesResponse> {
  const q = dirPath ? \`?path=\${encodeURIComponent(dirPath)}\` : ''
  return getJSON(\`/api/local-sync/browse\${q}\`)
}

export function createLocalDirectory(
  dirPath: string
): Promise<{ ok: boolean; normalizedPath: string }> {
  return postJSON('/api/local-sync/mkdir', { body: { path: dirPath } })
}

export function updateProjectLocalFolder(
  projectId: string,
  body: {
    customFolderPath: string | null
    syncEnabled?: boolean
    syncNow?: boolean
    cleanOld?: boolean
  }
): Promise<{
  ok: boolean
  localFolder: ProjectLocalFolderInfo
  syncResult?: { syncedFilesCount?: number } | null
}> {
  return postJSON(\`/project/\${projectId}/local-folder\`, { body })
}

export function syncProjectToLocalFolder(projectId: string): Promise<{
  ok: boolean
  localFolder: ProjectLocalFolderInfo
  syncResult?: { syncedFilesCount?: number }
}> {
  return postJSON(\`/project/\${projectId}/local-sync\`)
}`,
    'getLocalSyncSettings'
  )

  // 3. project-list-context.tsx
  replaceExact(
    'frontend/js/features/project-list/context/project-list-context.tsx',
    `import {
  ClonedProject,
  GetProjectsResponseBody,
  Project,
  Sort,
} from '../../../../../types/project/dashboard/api'`,
    `import {
  ClonedProject,
  GetProjectsResponseBody,
  LocalSyncSettings,
  Project,
  Sort,
} from '../../../../../types/project/dashboard/api'`,
    'LocalSyncSettings'
  )

  replaceExact(
    'frontend/js/features/project-list/context/project-list-context.tsx',
    `import { getProjects } from '../util/api'`,
    `import { getLocalSyncSettings, getProjects } from '../util/api'`,
    'getLocalSyncSettings'
  )

  replaceExact(
    'frontend/js/features/project-list/context/project-list-context.tsx',
    `  hasLeavableProjectsSelected: boolean
  hasDeletableProjectsSelected: boolean
}`,
    `  hasLeavableProjectsSelected: boolean
  hasDeletableProjectsSelected: boolean
  localSyncSettings: LocalSyncSettings | null
  setLocalSyncSettings: React.Dispatch<
    React.SetStateAction<LocalSyncSettings | null>
  >
  showBaseFolderModal: boolean
  openBaseFolderModal: () => void
  closeBaseFolderModal: () => void
  activeProjectForFolderModal: Project | null
  openProjectFolderModal: (project: Project) => void
  closeProjectFolderModal: () => void
  refreshProjectsList: () => Promise<void>
}`,
    'showBaseFolderModal:'
  )

  replaceExact(
    'frontend/js/features/project-list/context/project-list-context.tsx',
    `  const [searchText, setSearchText] = useState('')`,
    `  const [searchText, setSearchText] = useState('')
  const [localSyncSettings, setLocalSyncSettings] =
    useState<LocalSyncSettings | null>(null)
  const [showBaseFolderModal, setShowBaseFolderModal] = useState(false)
  const [activeProjectForFolderModal, setActiveProjectForFolderModal] =
    useState<Project | null>(null)

  useEffect(() => {
    getLocalSyncSettings()
      .then(setLocalSyncSettings)
      .catch(debugConsole.error)
  }, [])

  const openBaseFolderModal = useCallback(() => {
    setShowBaseFolderModal(true)
  }, [])

  const closeBaseFolderModal = useCallback(() => {
    setShowBaseFolderModal(false)
  }, [])

  const openProjectFolderModal = useCallback((project: Project) => {
    setActiveProjectForFolderModal(project)
  }, [])

  const closeProjectFolderModal = useCallback(() => {
    setActiveProjectForFolderModal(null)
  }, [])

  const refreshProjectsList = useCallback(async () => {
    try {
      const data = await getProjects(sort)
      setLoadedProjects(data.projects)
      setTotalProjectsCount(data.totalSize)
    } catch (err) {
      debugConsole.error(err)
    }
  }, [sort])`,
    'const [localSyncSettings, setLocalSyncSettings]'
  )

  replaceExact(
    'frontend/js/features/project-list/context/project-list-context.tsx',
    `      projectsPerTag,
      currentFilterProjectsCount,
      visibleProjects,
    }),`,
    `      projectsPerTag,
      currentFilterProjectsCount,
      visibleProjects,
      localSyncSettings,
      setLocalSyncSettings,
      showBaseFolderModal,
      openBaseFolderModal,
      closeBaseFolderModal,
      activeProjectForFolderModal,
      openProjectFolderModal,
      closeProjectFolderModal,
      refreshProjectsList,
    }),`,
    'activeProjectForFolderModal,\n      openProjectFolderModal,'
  )

  replaceExact(
    'frontend/js/features/project-list/context/project-list-context.tsx',
    `      projectsPerTag,
      currentFilterProjectsCount,
      visibleProjects,
    ]
  )`,
    `      projectsPerTag,
      currentFilterProjectsCount,
      visibleProjects,
      localSyncSettings,
      showBaseFolderModal,
      openBaseFolderModal,
      closeBaseFolderModal,
      activeProjectForFolderModal,
      openProjectFolderModal,
      closeProjectFolderModal,
      refreshProjectsList,
    ]
  )`,
    'activeProjectForFolderModal,\n      openProjectFolderModal,\n      closeProjectFolderModal,\n      refreshProjectsList,\n    ]\n  )'
  )

  // 4. pages/project-list.tsx: import local-folder.scss
  replaceExact(
    'frontend/js/pages/project-list.tsx',
    `import ProjectListRoot from '../features/project-list/components/project-list-root'`,
    `import '../features/project-list/components/local-folder/local-folder.scss'
import ProjectListRoot from '../features/project-list/components/project-list-root'`,
    'local-folder.scss'
  )

  // 5. project-list-ds-nav.tsx: mount BaseFolderSettingsModal + ProjectFolderModal (no duplicate top banner)
  removeExactIfPresent(
    'frontend/js/features/project-list/components/project-list-ds-nav.tsx',
    `\nimport LocalFolderBanner from './local-folder/local-folder-banner'`
  )

  replaceExact(
    'frontend/js/features/project-list/components/project-list-ds-nav.tsx',
    `import NoProjects from '@/features/project-list/components/no-projects'`,
    `import NoProjects from '@/features/project-list/components/no-projects'
import BaseFolderSettingsModal from './local-folder/base-folder-settings-modal'
import ProjectFolderModal from './local-folder/project-folder-modal'`,
    'BaseFolderSettingsModal'
  )

  replaceIfPresent(
    'frontend/js/features/project-list/components/project-list-ds-nav.tsx',
    `                  <div className="project-tools">
                    <div className="d-none d-md-block">
                      {selectedProjects.length === 0 ? (
                        showTrashHeader ? null : (
                          <div className="d-inline-flex align-items-center gap-3">
                            <CurrentPlanWidget />
                            <LocalFolderBanner />
                          </div>
                        )
                      ) : (
                        <ProjectTools />
                      )}
                    </div>
                    <div className="d-md-none">
                      {!showTrashHeader && (
                        <div className="d-inline-flex align-items-center flex-wrap gap-2">
                          <CurrentPlanWidget />
                          <LocalFolderBanner />
                        </div>
                      )}
                    </div>
                  </div>`,
    `                  <div className="project-tools">
                    <div className="d-none d-md-block">
                      {selectedProjects.length === 0 ? (
                        showTrashHeader ? null : (
                          <CurrentPlanWidget />
                        )
                      ) : (
                        <ProjectTools />
                      )}
                    </div>
                    <div className="d-md-none">
                      {!showTrashHeader && <CurrentPlanWidget />}
                    </div>
                  </div>`
  )

  replaceExact(
    'frontend/js/features/project-list/components/project-list-ds-nav.tsx',
    `          <CookieBanner />
        </div>
      </div>
    </div>`,
    `          <CookieBanner />
        </div>
      </div>
      <BaseFolderSettingsModal />
      <ProjectFolderModal />
    </div>`,
    '<BaseFolderSettingsModal />'
  )

  // 6. welcome-page-content.tsx: mount BaseFolderSettingsModal when 0 projects exist (no duplicate banner)
  removeExactIfPresent(
    'frontend/js/features/project-list/components/welcome-page-content.tsx',
    `\nimport LocalFolderBanner from '@/features/project-list/components/local-folder/local-folder-banner'`
  )

  removeExactIfPresent(
    'frontend/js/features/project-list/components/welcome-page-content.tsx',
    `          <LocalFolderBanner />\n`
  )

  replaceExact(
    'frontend/js/features/project-list/components/welcome-page-content.tsx',
    `import WelcomeMessage from '@/features/project-list/components/welcome-message'`,
    `import WelcomeMessage from '@/features/project-list/components/welcome-message'
import BaseFolderSettingsModal from '@/features/project-list/components/local-folder/base-folder-settings-modal'`,
    'BaseFolderSettingsModal'
  )

  replaceExact(
    'frontend/js/features/project-list/components/welcome-page-content.tsx',
    `          <WelcomeMessage />
        </OLCol>
      </OLRow>
    </div>`,
    `          <WelcomeMessage />
        </OLCol>
      </OLRow>
      <BaseFolderSettingsModal />
    </div>`,
    '<BaseFolderSettingsModal />'
  )

  // 7. sidebar-filters.tsx & sidebar-ds-nav.tsx: official compact icons + Folder Location in lower switcher
  replaceExact(
    'frontend/js/features/project-list/components/sidebar/sidebar-filters.tsx',
    `import { Folder } from '@phosphor-icons/react'`,
    `import { Archive, Files, User, Users } from '@phosphor-icons/react'`,
    'project-list-filters-compact-tags'
  )

  replaceExact(
    'frontend/js/features/project-list/components/sidebar/sidebar-filters.tsx',
    `  return (
    <ul className="list-unstyled project-list-filters">
      <SidebarFilter
        activePage={activePage}
        filter="all"
        text={t('projects')}
        icon={<Folder size={20} />}
      />
      <SidebarFilter
        activePage={activePage}
        filter="owned"
        text={t('your_projects')}
      />
      <SidebarFilter
        activePage={activePage}
        filter="shared"
        text={t('shared_with_you')}
      />
      <SidebarFilter
        activePage={activePage}
        filter="archived"
        text={t('archived_projects')}
      />
      <li aria-hidden="true">
        <hr />
      </li>
      <TagsList />
    </ul>
  )`,
    `  return (
    <ul className="list-unstyled project-list-filters project-list-filters-compact-tags">
      <SidebarFilter
        activePage={activePage}
        filter="all"
        text={t('all_projects')}
        icon={<Files size={20} />}
      />
      <li aria-hidden="true">
        <hr />
      </li>
      <SidebarFilter
        activePage={activePage}
        filter="owned"
        text={t('your_projects')}
        icon={<User size={20} />}
      />
      <SidebarFilter
        activePage={activePage}
        filter="shared"
        text={t('shared_with_you')}
        icon={<Users size={20} />}
      />
      <SidebarFilter
        activePage={activePage}
        filter="archived"
        text={t('archive')}
        icon={<Archive size={20} />}
      />
      <li aria-hidden="true">
        <hr />
      </li>
      <TagsList />
    </ul>
  )`,
    'project-list-filters-compact-tags'
  )

  replaceExact(
    'frontend/js/features/project-list/components/sidebar/sidebar-ds-nav.tsx',
    `import { Trash } from '@phosphor-icons/react'`,
    `import { FolderOpen, Package, Trash } from '@phosphor-icons/react'
import getMeta from '@/utils/meta'`,
    'FolderOpen, Package, Trash'
  )

  replaceIfPresent(
    'frontend/js/features/project-list/components/sidebar/sidebar-ds-nav.tsx',
    `  const { filter, selectedTagId, selectFilter, openBaseFolderModal } =
    useProjectListContext()`,
    `  const {
    filter,
    selectedTagId,
    selectFilter,
    openBaseFolderModal,
    localSyncSettings,
  } = useProjectListContext()`
  )

  replaceExact(
    'frontend/js/features/project-list/components/sidebar/sidebar-ds-nav.tsx',
    `  const { filter, selectedTagId, selectFilter } = useProjectListContext()`,
    `  const {
    filter,
    selectedTagId,
    selectFilter,
    openBaseFolderModal,
    localSyncSettings,
  } = useProjectListContext()`,
    'openBaseFolderModal'
  )

  replaceIfPresent(
    'frontend/js/features/project-list/components/sidebar/sidebar-ds-nav.tsx',
    `            <button
              type="button"
              className="ds-nav-page-switcher-item"
              onClick={openBaseFolderModal}
              data-testid="sidebar-folder-location-btn"
            >`,
    `            <button
              type="button"
              className="ds-nav-page-switcher-item"
              onClick={openBaseFolderModal}
              data-testid="sidebar-folder-location-btn"
              title={
                localSyncSettings?.baseDir
                  ? \`Default folder: \${localSyncSettings.baseDir}\`
                  : 'Default folder location'
              }
            >`
  )

  replaceExact(
    'frontend/js/features/project-list/components/sidebar/sidebar-ds-nav.tsx',
    `          {/* The trash view defaults to the location the user is navigating from:`,
    `          {getMeta('ol-ExposedSettings')?.hasPackageHubFeature && (
            <a
              href="/packages"
              className="ds-nav-page-switcher-item"
              data-testid="sidebar-package-hub-btn"
            >
              <Package size={20} />
              <span className="ds-nav-page-switcher-item-label">
                {t('package_hub', 'Package Hub')}
              </span>
            </a>
          )}
          {activePage !== 'library' && (
            <button
              type="button"
              className="ds-nav-page-switcher-item"
              onClick={openBaseFolderModal}
              data-testid="sidebar-folder-location-btn"
              title={
                localSyncSettings?.baseDir
                  ? \`Default folder: \${localSyncSettings.baseDir}\`
                  : 'Default folder location'
              }
            >
              <FolderOpen size={20} />
              <span className="ds-nav-page-switcher-item-label">
                Folder Location
              </span>
            </button>
          )}
          {/* The trash view defaults to the location the user is navigating from:`,
    'sidebar-folder-location-btn'
  )

  replaceExact(
    'frontend/js/features/project-list/components/dropdown/navigation-dropdown.tsx',
    `import { BookBookmark, Trash, Folder } from '@phosphor-icons/react'`,
    `import { BookBookmark, FolderOpen, Trash, Folder } from '@phosphor-icons/react'`,
    'FolderOpen'
  )

  replaceExact(
    'frontend/js/features/project-list/components/dropdown/navigation-dropdown.tsx',
    `  const { filter, selectedTagId, tags } = useProjectListContext()`,
    `  const { filter, selectedTagId, tags, openBaseFolderModal } =
    useProjectListContext()`,
    'openBaseFolderModal'
  )

  replaceExact(
    'frontend/js/features/project-list/components/dropdown/navigation-dropdown.tsx',
    `            <li role="none">
              <OLDropdownItem
                as="button"
                tabIndex={-1}
                trailingIcon="chevron_right"
                leadingIcon={<Trash size={20} />}`,
    `            {activePage !== 'library' && (
              <li role="none">
                <OLDropdownItem
                  as="button"
                  tabIndex={-1}
                  leadingIcon={<FolderOpen size={20} />}
                  onClick={openBaseFolderModal}
                >
                  Folder Location
                </OLDropdownItem>
              </li>
            )}
            <li role="none">
              <OLDropdownItem
                as="button"
                tabIndex={-1}
                trailingIcon="chevron_right"
                leadingIcon={<Trash size={20} />}`,
    'Folder Location'
  )

  // 8. project-list-table-row.tsx: render inline ProjectFolderBadge next to tags (only custom/error/paused)
  replaceExact(
    'frontend/js/features/project-list/components/table/project-list-table-row.tsx',
    `import InlineTags from './cells/inline-tags'`,
    `import InlineTags from './cells/inline-tags'
import ProjectFolderBadge from '../local-folder/project-folder-badge'`,
    'ProjectFolderBadge'
  )

  replaceExact(
    'frontend/js/features/project-list/components/table/project-list-table-row.tsx',
    `        <a href={\`/project/\${project.id}\`} translate="no">
          {project.name}
        </a>{' '}
        <InlineTags className="d-none d-md-inline" projectId={project.id} />`,
    `        <a href={\`/project/\${project.id}\`} translate="no">
          {project.name}
        </a>{' '}
        <InlineTags className="d-none d-md-inline" projectId={project.id} />
        <ProjectFolderBadge project={project} />`,
    '<ProjectFolderBadge project={project} />'
  )

  // 9 & 10. actions-cell.tsx & actions-dropdown.tsx: keep row actions minimal and native
  copyStagedFile(
    'frontend/js/features/project-list/components/table/cells/actions-cell.tsx'
  )
  copyStagedFile(
    'frontend/js/features/project-list/components/dropdown/actions-dropdown.tsx'
  )

  // 11. Package Hub native integration (ExposedSettings, Meta, i18n, Navbar cleanup, AccountMenu, AdminMenu, Sidebar)
  replaceExact(
    'types/exposed-settings.ts',
    `  enablePandocConversions: boolean
}`,
    `  enablePandocConversions: boolean
  hasPackageHubFeature?: boolean
}`,
    'hasPackageHubFeature?'
  )

  replaceExact(
    'frontend/js/utils/meta.ts',
    `  'ol-wsUrl': string
}`,
    `  'ol-packageHubConfig'?: {
    canMutate: boolean
    canUpload: boolean
    isAdmin: boolean
  }
  'ol-wsUrl': string
}`,
    "'ol-packageHubConfig'?"
  )

  replaceExact(
    'frontend/js/i18n.ts',
    `import { resources } from '@/i18n-resources/writefull'`,
    `import { resources } from '@/i18n-resources/writefull'
import { packageHubTranslations } from '@/i18n-resources/package-hub'`,
    'packageHubTranslations'
  )

  replaceExact(
    'frontend/js/i18n.ts',
    `  i18n.addResourceBundle(
    LANG,
    'writefull',
    LANG === 'es' ? resources.es.writefull : resources.en.writefull
  )`,
    `  i18n.addResourceBundle(
    LANG,
    'writefull',
    LANG === 'es' ? resources.es.writefull : resources.en.writefull
  )
  i18n.addResourceBundle(
    LANG,
    'translation',
    packageHubTranslations,
    true,
    true
  )`,
    'packageHubTranslations,\n    true'
  )

  // Remove duplicate Package Hub top navbar link (already in sidebar & Account menu)
  removeExactIfPresent(
    'frontend/js/shared/components/navbar/logged-in-items.tsx',
    `\nimport getMeta from '@/utils/meta'`
  )

  removeExactIfPresent(
    'frontend/js/shared/components/navbar/logged-in-items.tsx',
    `\n  const hasPackageHub = getMeta('ol-ExposedSettings')?.hasPackageHubFeature`
  )

  removeExactIfPresent(
    'frontend/js/shared/components/navbar/logged-in-items.tsx',
    `\n      {hasPackageHub && (
        <NavLinkItem href="/packages" className="nav-item-packages">
          {t('package_hub', 'Package Hub')}
        </NavLinkItem>
      )}`
  )

  replaceExact(
    'frontend/js/shared/components/navbar/account-menu-items.tsx',
    `  const hasOverallThemes = Boolean(getMeta('ol-overallThemes'))`,
    `  const hasOverallThemes = Boolean(getMeta('ol-overallThemes'))
  const hasPackageHub = Boolean(
    getMeta('ol-ExposedSettings')?.hasPackageHubFeature
  )`,
    'hasPackageHub = Boolean'
  )

  replaceExact(
    'frontend/js/shared/components/navbar/account-menu-items.tsx',
    `      <NavDropdownLinkItem href="/user/settings">
        {t('account_settings')}
      </NavDropdownLinkItem>`,
    `      <NavDropdownLinkItem href="/user/settings">
        {t('account_settings')}
      </NavDropdownLinkItem>
      {hasPackageHub && (
        <NavDropdownLinkItem href="/packages">
          {t('package_hub', 'Package Hub')}
        </NavDropdownLinkItem>
      )}`,
    'href="/packages"'
  )

  replaceExact(
    'frontend/js/shared/components/navbar/admin-menu.tsx',
    `import NavDropdownLinkItem from '@/shared/components/navbar/nav-dropdown-link-item'`,
    `import NavDropdownLinkItem from '@/shared/components/navbar/nav-dropdown-link-item'
import getMeta from '@/utils/meta'`,
    "import getMeta from '@/utils/meta'"
  )

  replaceExact(
    'frontend/js/shared/components/navbar/admin-menu.tsx',
    `          <NavDropdownLinkItem href="/admin/user">
            Manage Users
          </NavDropdownLinkItem>`,
    `          <NavDropdownLinkItem href="/admin/user">
            Manage Users
          </NavDropdownLinkItem>
          {getMeta('ol-ExposedSettings')?.hasPackageHubFeature && (
            <NavDropdownLinkItem href="/packages">
              Manage Packages
            </NavDropdownLinkItem>
          )}`,
    'Manage Packages'
  )

  // 12. Remove Digital Science branding & wire auth/setup/profile frontend improvements
  removeExactIfPresent(
    'frontend/js/shared/components/sidebar/sidebar-lower-section.tsx',
    `      <div className="ds-nav-ds-name" translate="no">
        <span>Digital Science</span>
      </div>`
  )

  replaceExact(
    'frontend/js/shared/components/sidebar/ds-nav-overleaf-logo.tsx',
    `import overleafLogo from '@/shared/svgs/overleaf-a-ds-solution-mallard.svg'
import overleafLogoDark from '@/shared/svgs/overleaf-a-ds-solution-mallard-dark.svg'`,
    `import overleafLogo from '@/shared/svgs/overleaf-green.svg'
import overleafLogoDark from '@/shared/svgs/overleaf-white.svg'`,
    'overleaf-green.svg'
  )

  replaceIfPresent(
    'frontend/js/shared/components/sidebar/ds-nav-overleaf-logo.tsx',
    `export function DsNavOverleafLogo() {
  const appName = getMeta('ol-ExposedSettings')?.appName ?? 'Overleaf'
  const activeOverallTheme = useActiveOverallTheme()

  return (
    <div className="ds-nav-page-switcher-logo">
      <a href="/" aria-label={appName}>
        <img
          src={activeOverallTheme === 'dark' ? overleafLogoDark : overleafLogo}
          alt={appName}
          height="38"
          width="130"
        />
      </a>
    </div>
  )
}`,
    `export function DsNavOverleafLogo() {
  const appName = getMeta('ol-ExposedSettings')?.appName ?? 'Overleaf'
  const navbarMeta = getMeta('ol-navbar')
  const brandLabel = navbarMeta?.organizationName || appName
  const activeOverallTheme = useActiveOverallTheme()
  const logoSrc =
    activeOverallTheme === 'dark'
      ? navbarMeta?.customLogoDark || navbarMeta?.customLogo || overleafLogoDark
      : navbarMeta?.customLogo || overleafLogo

  return (
    <div className="ds-nav-page-switcher-logo">
      <a href="/" aria-label={brandLabel}>
        <img
          src={logoSrc}
          alt={brandLabel}
          height="42"
          width="118"
          style={{
            height: '42px',
            width: 'auto',
            maxWidth: '158px',
            objectFit: 'contain',
            objectPosition: 'left center',
          }}
        />
      </a>
    </div>
  )
}`
  )

  replaceExact(
    'frontend/js/shared/components/sidebar/ds-nav-overleaf-logo.tsx',
    `export function DsNavOverleafLogo() {
  const appName = getMeta('ol-ExposedSettings')?.appName ?? 'Overleaf'
  const activeOverallTheme = useActiveOverallTheme()

  return (
    <div className="ds-nav-page-switcher-logo">
      <a href="/" aria-label={appName}>
        <img
          src={activeOverallTheme === 'dark' ? overleafLogoDark : overleafLogo}
          alt="Overleaf, A Digital Science Solution"
          height="59"
          width="130"
        />
      </a>
    </div>
  )
}`,
    `export function DsNavOverleafLogo() {
  const appName = getMeta('ol-ExposedSettings')?.appName ?? 'Overleaf'
  const navbarMeta = getMeta('ol-navbar')
  const brandLabel = navbarMeta?.organizationName || appName
  const activeOverallTheme = useActiveOverallTheme()
  const logoSrc =
    activeOverallTheme === 'dark'
      ? navbarMeta?.customLogoDark || navbarMeta?.customLogo || overleafLogoDark
      : navbarMeta?.customLogo || overleafLogo

  return (
    <div className="ds-nav-page-switcher-logo">
      <a href="/" aria-label={brandLabel}>
        <img
          src={logoSrc}
          alt={brandLabel}
          height="42"
          width="118"
          style={{
            height: '42px',
            width: 'auto',
            maxWidth: '158px',
            objectFit: 'contain',
            objectPosition: 'left center',
          }}
        />
      </a>
    </div>
  )
}`,
    'navbarMeta?.customLogo'
  )

  replaceIfPresent(
    'frontend/js/shared/components/sidebar/ds-nav-overleaf-logo.tsx',
    `          height="38"
          width="130"
          style={{ objectFit: 'contain', objectPosition: 'left center' }}`,
    `          height="42"
          width="118"
          style={{
            height: '42px',
            width: 'auto',
            maxWidth: '158px',
            objectFit: 'contain',
            objectPosition: 'left center',
          }}`
  )

  replaceExact(
    'frontend/js/features/project-list/components/project-list-ds-nav.tsx',
    `import overleafLogo from '@/shared/svgs/overleaf-a-ds-solution-mallard.svg'
import overleafLogoDark from '@/shared/svgs/overleaf-a-ds-solution-mallard-dark.svg'`,
    `import overleafLogo from '@/shared/svgs/overleaf-green.svg'
import overleafLogoDark from '@/shared/svgs/overleaf-white.svg'`,
    'overleaf-green.svg'
  )

  removeExactIfPresent(
    'frontend/js/shared/components/layouts/ciam-layout.tsx',
    `\nimport dsLogo from '@/shared/svgs/digital-science.svg'`
  )

  removeExactIfPresent(
    'frontend/js/shared/components/layouts/ciam-layout.tsx',
    `          <div className="ciam-footer-ds-logo">
            <a
              href="https://www.digital-science.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="ciam-image-link"
              onClick={() =>
                eventTracking.sendMB('unified-access-footer-click', {
                  product: 'overleaf',
                  item: 'logo',
                  destinationUrl: 'https://www.digital-science.com/',
                })
              }
            >
              <img src={dsLogo} alt="Digital Science — home" />
            </a>
          </div>`
  )

  replaceExact(
    'frontend/stylesheets/ciam/ciam-layout.scss',
    `background-image: url('../../../frontend/js/shared/svgs/overleaf-a-ds-solution-mallard.svg');`,
    `background-image: url('../../../frontend/js/shared/svgs/overleaf-green.svg');`,
    'overleaf-green.svg'
  )

  removeExactIfPresent(
    'frontend/js/shared/components/footer/fat-footer-base.tsx',
    `          <FooterBaseLink href="https://www.digital-science.com/security-certifications/">
            {t('compliance')}
          </FooterBaseLink>`
  )

  removeExactIfPresent(
    'frontend/js/shared/components/footer/fat-footer.tsx',
    `        { href: 'https://digitalscience.pinpointhq.com/', label: t('careers') },\n`
  )

  copyStagedFile('frontend/stylesheets/pages/auth-launchpad.scss')
  copyStagedFile('frontend/js/features/settings/components/account-info-section.tsx')

  replaceExact(
    'frontend/js/marketing.ts',
    `import './utils/webpack-public-path'`,
    `import '../stylesheets/pages/auth-launchpad.scss'
import './utils/webpack-public-path'`,
    'auth-launchpad.scss'
  )

  replaceExact(
    'frontend/js/pages/user/settings.tsx',
    `import { renderInReactLayout } from '@/react'`,
    `import '../../../stylesheets/pages/auth-launchpad.scss'
import { renderInReactLayout } from '@/react'`,
    'auth-launchpad.scss'
  )

  replaceExact(
    'types/user.ts',
    `  first_name?: string
  last_name?: string`,
    `  first_name?: string
  last_name?: string
  role?: string
  institution?: string`,
    'institution?: string'
  )

  replaceExact(
    'types/user.ts',
    `  first_name?: undefined
  last_name?: undefined`,
    `  first_name?: undefined
  last_name?: undefined
  role?: undefined
  institution?: undefined`,
    'institution?: undefined'
  )

  replaceExact(
    'frontend/js/features/settings/data/roles.ts',
    `const roles = <const>[
  'Undergraduate Student',
  'Masters Student (MSc, MA, ...)',
  'Doctoral Student (PhD, EngD, ...)',
  'Postdoc',
  'Lecturer',
  'Senior Lecturer',
  'Reader',
  'Associate Professor ',
  'Assistant Professor ',
  'Professor',
  'Emeritus Professor',
]`,
    `const roles = <const>[
  'Undergraduate Student',
  'Masters Student (MSc, MA, ...)',
  'Doctoral Student (PhD, EngD, ...)',
  'Postdoc',
  'Researcher',
  'Lecturer',
  'Senior Lecturer',
  'Reader',
  'Associate Professor',
  'Assistant Professor',
  'Professor',
  'Emeritus Professor',
  'Software Engineer',
  'Engineer',
  'Data Scientist',
  'Technical Writer',
  'Independent Researcher',
  'Other',
]`,
    'Independent Researcher'
  )

  replaceExact(
    'modules/launchpad/frontend/js/pages/launchpad.ts',
    `if (getMeta('ol-adminUserExists')) {
  setUpStatusIndicators()
}`,
    `function setUpConfirmPasswordValidation() {
  const passwordInput = document.getElementById(
    'passwordField'
  ) as HTMLInputElement | null
  const confirmInput = document.getElementById(
    'confirmPasswordField'
  ) as HTMLInputElement | null
  if (!passwordInput || !confirmInput) return

  const syncValidity = () => {
    if (confirmInput.value && confirmInput.value !== passwordInput.value) {
      confirmInput.setCustomValidity('Passwords do not match')
    } else {
      confirmInput.setCustomValidity('')
    }
  }

  passwordInput.addEventListener('input', syncValidity)
  confirmInput.addEventListener('input', syncValidity)
}

setUpConfirmPasswordValidation()

if (getMeta('ol-adminUserExists')) {
  setUpStatusIndicators()
}`,
    'setUpConfirmPasswordValidation'
  )

  // 13. Enterprise Admin Console UI & navbar alignment
  replaceExact(
    'frontend/js/shared/components/navbar/admin-menu.tsx',
    `          <NavDropdownLinkItem href="/admin">Manage Site</NavDropdownLinkItem>`,
    `          <NavDropdownLinkItem href="/admin">System Admin</NavDropdownLinkItem>`,
    '>System Admin</NavDropdownLinkItem>'
  )

  replaceExact(
    'frontend/js/shared/components/navbar/account-menu-items.tsx',
    `  const hasPackageHub = Boolean(
    getMeta('ol-ExposedSettings')?.hasPackageHubFeature
  )`,
    `  const hasPackageHub = Boolean(
    getMeta('ol-ExposedSettings')?.hasPackageHubFeature
  )
  const isSiteAdmin = Boolean(getMeta('ol-navbar')?.canDisplayAdminMenu)`,
    'isSiteAdmin = Boolean'
  )

  replaceExact(
    'frontend/js/shared/components/navbar/account-menu-items.tsx',
    `      {hasPackageHub && (
        <NavDropdownLinkItem href="/packages">
          {t('package_hub', 'Package Hub')}
        </NavDropdownLinkItem>
      )}`,
    `      {hasPackageHub && (
        <NavDropdownLinkItem href="/packages">
          {t('package_hub', 'Package Hub')}
        </NavDropdownLinkItem>
      )}
      {isSiteAdmin && (
        <>
          <NavDropdownLinkItem href="/admin">System Admin</NavDropdownLinkItem>
          <NavDropdownLinkItem href="/admin/user">
            Manage Users
          </NavDropdownLinkItem>
        </>
      )}`,
    'href="/admin">System Admin'
  )

  replaceExact(
    'modules/user-activate/frontend/js/components/register-form.jsx',
    `  let emails = emailsText.split(regexBySpaceOrComma)
  emails.map(email => email.trim())
  emails = emails.filter(email => email.indexOf('@') !== -1)`,
    `  let emails = emailsText
    .split(regexBySpaceOrComma)
    .map(email => email.trim())
    .filter(email => email.includes('@'))`,
    ".filter(email => email.includes('@'))"
  )

  replaceExact(
    'frontend/js/utils/meta.ts',
    `  'ol-wsUrl': string
}`,
    `  'ol-adminInitialTab'?: 'overview' | 'users' | 'maintenance'
  'ol-wsUrl': string
}`,
    "'ol-adminInitialTab'?"
  )

  copyStagedFile('frontend/js/features/admin/api.ts')
  copyStagedFile('frontend/js/features/admin/admin-console.scss')
  copyStagedFile('frontend/js/features/admin/overview-tab.tsx')
  copyStagedFile('frontend/js/features/admin/users-tab.tsx')
  copyStagedFile('frontend/js/features/admin/maintenance-tab.tsx')
  copyStagedFile('frontend/js/features/admin/admin-console-root.tsx')
  copyStagedFile('frontend/js/pages/admin.tsx')

  // 14. Clean COSL Edition SVG navbar brand logo (logo only, no odd navbar-title text)
  replaceExact(
    'frontend/js/shared/components/navbar/header-logo-or-title.tsx',
    `import type { DefaultNavbarMetadata } from '@/shared/components/types/default-navbar-metadata'
import getMeta from '@/utils/meta'

export default function HeaderLogoOrTitle({
  overleafLogo,
  customLogo,
  title,
}: Pick<DefaultNavbarMetadata, 'customLogo' | 'title'> & {
  overleafLogo?: string
}) {
  const { appName } = getMeta('ol-ExposedSettings')
  const logoUrl = customLogo ?? overleafLogo
  return (
    <a href="/" aria-label={appName} className="navbar-brand">
      {(customLogo || !title) && (
        <div
          className="navbar-logo"
          style={logoUrl ? { backgroundImage: \`url("\${logoUrl}")\` } : {}}
        />
      )}
      {title && (
        <div className="navbar-title">
          <span>{title}</span>
        </div>
      )}
    </a>
  )
}`,
    `import type { DefaultNavbarMetadata } from '@/shared/components/types/default-navbar-metadata'
import getMeta from '@/utils/meta'
import overleafGreenLogo from '@/shared/svgs/overleaf-green.svg'
import overleafWhiteLogo from '@/shared/svgs/overleaf-white.svg'

const LEGACY_PLACEHOLDER_TITLES = new Set([
  'Our Overleaf Instance',
  'Overleaf Community Edition',
  'Overleaf (Community Edition)',
])

function isDarkNavbarContext() {
  if (typeof document === 'undefined') return true
  const isRedesign =
    document.body.classList.contains('website-redesign') ||
    Boolean(
      document.querySelector('.website-redesign, .website-redesign-navbar')
    )
  if (!isRedesign) return true
  const isDashboardRoot = Boolean(
    document.getElementById('project-list-root') ||
      document.getElementById('library-root')
  )
  const activeTheme =
    document.body.dataset.theme || document.body.dataset.initialTheme
  return isDashboardRoot && activeTheme !== 'light'
}

export default function HeaderLogoOrTitle({
  overleafLogo,
  customLogo,
}: Pick<DefaultNavbarMetadata, 'customLogo' | 'title'> & {
  overleafLogo?: string
}) {
  const appName = getMeta('ol-ExposedSettings')?.appName
  const organizationName = getMeta('ol-navbar')?.organizationName
  const brandLabel =
    organizationName ||
    (appName && !LEGACY_PLACEHOLDER_TITLES.has(appName.trim())
      ? appName
      : 'Overleaf')
  const fallbackLogo = isDarkNavbarContext()
    ? overleafWhiteLogo
    : overleafGreenLogo
  const logoUrl = customLogo ?? overleafLogo ?? fallbackLogo

  return (
    <a href="/" aria-label={brandLabel} className="navbar-brand">
      <div
        className="navbar-logo"
        style={
          logoUrl ? { backgroundImage: \`url("\${logoUrl}")\` } : undefined
        }
      />
    </a>
  )
}`,
    'LEGACY_PLACEHOLDER_TITLES'
  )

  replaceIfPresent(
    'frontend/js/shared/components/navbar/header-logo-or-title.tsx',
    `      {(customLogo || !effectiveTitle) && (
        <div
          className="navbar-logo"
          style={
            logoUrl ? { backgroundImage: \`url("\${logoUrl}")\` } : undefined
          }
        />
      )}
      {effectiveTitle && (
        <div className="navbar-title">
          <span>{effectiveTitle}</span>
        </div>
      )}`,
    `      <div
        className="navbar-logo"
        style={
          logoUrl ? { backgroundImage: \`url("\${logoUrl}")\` } : undefined
        }
      />`
  )

  // 15. Enterprise Project Access & User-to-User Sharing UI
  copyStagedFile('frontend/js/features/admin/projects-access-tab.tsx')
  copyStagedFile(
    'frontend/js/features/project-list/components/sharing/project-sharing.scss'
  )
  copyStagedFile(
    'frontend/js/features/project-list/components/sharing/project-sharing-badge.tsx'
  )
  copyStagedFile(
    'frontend/js/features/project-list/components/sharing/share-project-modal-button.tsx'
  )

  replaceExact(
    'frontend/js/utils/meta.ts',
    `  'ol-adminInitialTab'?: 'overview' | 'users' | 'maintenance'`,
    `  'ol-adminInitialTab'?: 'overview' | 'users' | 'projects' | 'maintenance'`,
    "'projects' | 'maintenance'"
  )

  replaceExact(
    'types/project/dashboard/api.d.ts',
    `  localFolder?: ProjectLocalFolderInfo
}`,
    `  localFolder?: ProjectLocalFolderInfo
  sharingInfo?: {
    source: 'owner' | 'direct' | 'enterprise' | 'token'
    scope: 'private' | 'network' | 'all_users' | 'custom'
    networkOnly: boolean
    permissionMode: 'edit' | 'copy' | 'view_only'
    allowCopy: boolean
    collaboratorCount: number
    enterprisePermissionMode?: 'edit' | 'copy' | 'view_only' | null
  }
}`,
    'sharingInfo?:'
  )

  replaceExact(
    'frontend/js/pages/project-list.tsx',
    `import '../features/project-list/components/local-folder/local-folder.scss'`,
    `import '../features/project-list/components/local-folder/local-folder.scss'
import '../features/project-list/components/sharing/project-sharing.scss'`,
    'project-sharing.scss'
  )

  replaceExact(
    'frontend/js/features/project-list/components/table/project-list-table-row.tsx',
    `import ProjectFolderBadge from '../local-folder/project-folder-badge'`,
    `import ProjectFolderBadge from '../local-folder/project-folder-badge'
import ProjectSharingBadge from '../sharing/project-sharing-badge'`,
    'ProjectSharingBadge'
  )

  replaceExact(
    'frontend/js/features/project-list/components/table/project-list-table-row.tsx',
    `        <ProjectFolderBadge project={project} />`,
    `        <ProjectFolderBadge project={project} />
        <ProjectSharingBadge project={project} />`,
    '<ProjectSharingBadge project={project} />'
  )

  replaceExact(
    'frontend/js/features/project-list/components/table/cells/action-buttons/copy-project-button.tsx',
    `  const { t } = useTranslation()
  const text = t('copy')`,
    `  const { t } = useTranslation()
  const text =
    project.accessLevel !== 'owner' ? t('use_as_a_copy', 'Use as a copy') : t('copy')`,
    'use_as_a_copy'
  )

  replaceExact(
    'frontend/js/features/project-list/components/table/cells/action-buttons/copy-project-button.tsx',
    `  if (project.archived || project.trashed) return null`,
    `  if (project.archived || project.trashed || project.sharingInfo?.allowCopy === false) return null`,
    'allowCopy === false'
  )

  replaceExact(
    'frontend/js/features/project-list/components/table/cells/action-buttons/leave-project-button.tsx',
    `  if (!project.trashed || isOwner) return null`,
    `  if (!project.trashed || isOwner || project.sharingInfo?.source === 'enterprise') return null`,
    "source === 'enterprise'"
  )

  // 16. Unified Original Overleaf ShareProjectModal & Enterprise Sharing across IDE + Dashboard + Admin
  copyStagedFile('frontend/js/shared/context/types/project-metadata.tsx')
  copyStagedFile('frontend/js/shared/context/editor-context.tsx')
  copyStagedFile('frontend/js/features/ide-react/hooks/use-socket-listeners.ts')
  copyStagedFile('frontend/js/features/ide-react/components/toolbar/menu-bar.tsx')
  copyStagedFile('frontend/js/features/ide-react/components/toolbar/share-project-button.tsx')
  copyStagedFile('frontend/js/features/clone-project-modal/components/clone-project-modal-content.tsx')
  copyStagedFile('frontend/js/features/share-project-modal/share-enterprise.scss')
  copyStagedFile('frontend/js/features/share-project-modal/utils/api.ts')
  copyStagedFile('frontend/js/features/share-project-modal/components/enterprise-access-section.tsx')
  copyStagedFile('frontend/js/features/share-project-modal/components/error-message.tsx')
  copyStagedFile('frontend/js/features/share-project-modal/components/member-privileges.tsx')
  copyStagedFile('frontend/js/features/share-project-modal/components/view-member.tsx')
  copyStagedFile('frontend/js/features/share-project-modal/components/add-collaborators-select.tsx')
  copyStagedFile('frontend/js/features/share-project-modal/components/edit-member.tsx')
  copyStagedFile('frontend/js/features/share-project-modal/components/link-sharing.tsx')
  copyStagedFile('frontend/js/features/share-project-modal/components/copy-sharing-link-button.tsx')
  copyStagedFile('frontend/js/features/share-project-modal/components/share-project-modal.tsx')
  copyStagedFile('frontend/js/features/share-project-modal/components/share-project-modal-content.tsx')
  copyStagedFile('frontend/js/features/share-project-modal/components/share-modal-body.tsx')
  copyStagedFile('frontend/js/features/share-project-modal/components/project-access.tsx')
  copyStagedFile('frontend/js/features/share-project-modal/components/invited-people.tsx')

  replaceExact(
    'frontend/js/shared/components/types/default-navbar-metadata.ts',
    `  customLogo?: string
  customLogoDark?: string`,
    `  customLogo?: string
  customLogoDark?: string
  organizationName?: string`,
    'organizationName?: string'
  )

  replaceExact(
    'frontend/js/features/project-list/components/table/project-tools/buttons/tags-dropdown.tsx',
    `      <OLDropdown align="end" autoClose="outside">
        <OLDropdownToggle
          id="project-tools-more-dropdown"
          variant="secondary"
          aria-label={t('tags')}
        >
          <MaterialIcon type="label" className="align-text-top" />
        </OLDropdownToggle>
        <OLDropdownMenu
          flip={false}
          data-testid="project-tools-more-dropdown-menu"
        >`,
    `      <OLDropdown align="end" autoClose="outside">
        <OLDropdownToggle
          id="project-tools-tags-dropdown"
          variant="secondary"
          aria-label={t('organize_tags')}
        >
          <MaterialIcon type="label" className="align-text-top" />
        </OLDropdownToggle>
        <OLDropdownMenu
          flip={false}
          data-testid="project-tools-tags-dropdown-menu"
        >`,
    'project-tools-tags-dropdown'
  )

  replaceIfPresent(
    'frontend/js/features/project-list/components/table/project-tools/buttons/tags-dropdown.tsx',
    `        <OLDropdownToggle
          id="project-tools-tags-dropdown"
          variant="secondary"
          title={t('organize_tags')}
          aria-label={t('organize_tags')}
        >`,
    `        <OLDropdownToggle
          id="project-tools-tags-dropdown"
          variant="secondary"
          aria-label={t('organize_tags')}
        >`
  )

  // 17. Minimal native /project cleanup, Organize Tags single-project menu, warning footer removal, and clean UI copy
  copyStagedFile('frontend/js/features/project-list/components/table/cells/action-buttons/organize-tags-project-button.tsx')
  copyStagedFile('frontend/js/shared/components/footer/thin-footer.tsx')
  copyStagedFile('frontend/js/features/project-list/components/local-folder/local-folder.scss')
  copyStagedFile('frontend/js/features/project-list/components/local-folder/project-folder-badge.tsx')
  copyStagedFile('frontend/js/features/package-hub/components/package-card.tsx')
  copyStagedFile('frontend/js/features/package-hub/components/package-details-modal.tsx')
  copyStagedFile('frontend/js/i18n-resources/package-hub.ts')

  // 18. Cloud ZIP (< 30 MB) frontend UI in IDE File->Download / title dropdown and /project row, toolbar & 3-dot menu
  copyStagedFile('frontend/js/shared/components/cloud-export-modal.tsx')
  copyStagedFile('frontend/js/features/ide-react/components/toolbar/download-project.tsx')
  copyStagedFile('frontend/js/features/ide-react/components/toolbar/project-title.tsx')
  copyStagedFile('frontend/js/features/project-list/components/table/cells/action-buttons/cloud-download-project-button.tsx')
  copyStagedFile('frontend/js/features/project-list/components/table/project-tools/project-tools.tsx')
  copyStagedFile('frontend/js/features/project-list/components/table/project-tools/buttons/project-tools-more-dropdown-button.tsx')

  // 19. COSL Edition SVG brand logos & responsive header/logo sizing (logo only on top bar)
  copyStagedFile('frontend/stylesheets/cosl-brand-navbar.scss')
  copyStagedFile('frontend/js/features/package-hub/components/package-hub.scss')
  for (const svgName of [
    'overleaf-green.svg',
    'overleaf-white.svg',
    'overleaf.svg',
    'overleaf-black.svg',
  ]) {
    copyStagedFile(`frontend/js/shared/svgs/${svgName}`)
    copyStagedFile(`public/img/ol-brand/${svgName}`)
  }

  replaceExact(
    'frontend/stylesheets/components/nav.scss',
    `  --navbar-brand-width: 130px;`,
    `  --navbar-brand-width: 158px;`,
    '--navbar-brand-width: 158px'
  )

  replaceExact(
    'frontend/stylesheets/components/navbar.scss',
    `    .navbar-logo {
      flex: 0 0 auto;
      width: var(--navbar-brand-width);
      height: $header-height;
      padding: 0;`,
    `    .navbar-logo {
      flex: 0 0 auto;
      width: var(--navbar-brand-width);
      height: calc($header-height - 14px);
      align-self: center;
      padding: 0;`,
    'calc($header-height - 14px)'
  )

  replaceExact(
    'frontend/stylesheets/pages/project-list-ds-nav.scss',
    `    .navbar-header .navbar-logo {
      @include media-breakpoint-up(md) {
        position: relative;
        top: calc(var(--spacing-05) * 2);
        left: var(--spacing-05);
      }
    }`,
    `    .navbar-header .navbar-logo {
      @include media-breakpoint-up(md) {
        position: relative;
        top: 0;
        left: var(--spacing-05);
      }
    }`,
    'top: 0;'
  )

  replaceExact(
    'frontend/stylesheets/pages/project-list-ds-nav.scss',
    `      .ds-nav-page-switcher-logo {
        padding: 0 var(--spacing-08) var(--spacing-04);

        img {
          width: 130px;
          height: auto;
        }
      }`,
    `      .ds-nav-page-switcher-logo {
        padding: 0 var(--spacing-08) var(--spacing-04);

        img {
          width: auto;
          max-width: 158px;
          height: 42px;
        }
      }`,
    'max-width: 158px;'
  )
}

if (mode === 'backend' || mode === 'all') {
  applyBackendPatches()
}
if (mode === 'frontend' || mode === 'all') {
  applyFrontendPatches()
}
console.log(`All ${mode} patches applied cleanly.`)
