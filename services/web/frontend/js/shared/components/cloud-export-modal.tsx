import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import MaterialIcon from '@/shared/components/material-icon'
import Notification from '@/shared/components/notification'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormCheckbox from '@/shared/components/ol/ol-form-checkbox'
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import { postJSON } from '@/infrastructure/fetch-json'

export type CloudZipDroppedFile = {
  relPath: string
  bytes: number
  reason: string
}

export type CloudZipOptimizedFile = {
  relPath: string
  originalBytes: number
  newBytes: number
  savedBytes: number
  method: string
}

export type CloudZipPrepareResult = {
  ok: boolean
  jobId: string
  filename: string
  rootDoc: string | null
  targetMaxMb: number
  originalBytes: number
  cloudBytes: number
  originalCount: number
  keptCount: number
  droppedCount: number
  droppedFiles: CloudZipDroppedFile[]
  compressedFiles: CloudZipOptimizedFile[]
  fitsLimit: boolean
  warning: string | null
  downloadUrl: string
}

type CloudExportModalProps = {
  projectId: string
  projectName: string
  show: boolean
  onClose: () => void
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatReasonLabel(reason: string): string {
  switch (reason) {
    case 'draft_or_local_pdf':
      return 'Draft PDF'
    case 'script_or_code':
      return 'Local script'
    case 'build_artifact':
      return 'Build file'
    case 'unused_tex':
      return 'Unused TeX'
    default:
      return 'Unused asset'
  }
}

export default function CloudExportModal({
  projectId,
  projectName,
  show,
  onClose,
}: CloudExportModalProps) {
  const { t } = useTranslation()
  const [targetMaxMb, setTargetMaxMb] = useState<25 | 30>(25)
  const [pruneUnused, setPruneUnused] = useState(true)
  const [compressImages, setCompressImages] = useState(true)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CloudZipPrepareResult | null>(null)
  const [showDetails, setShowDetails] = useState(false)

  useEffect(() => {
    if (show) {
      setError(null)
      setResult(null)
      setShowDetails(false)
    }
  }, [show, projectId])

  const handlePrepare = useCallback(async () => {
    if (preparing) return
    setPreparing(true)
    setError(null)
    try {
      const data = await postJSON<CloudZipPrepareResult>(
        `/project/${encodeURIComponent(projectId)}/download/cloud-zip`,
        {
          body: {
            targetMaxMb,
            pruneUnused,
            compressImages,
          },
        }
      )
      setResult(data)
    } catch (err: any) {
      setError(
        err?.data?.error ||
          err?.message ||
          t('generic_something_went_wrong')
      )
    } finally {
      setPreparing(false)
    }
  }, [projectId, targetMaxMb, pruneUnused, compressImages, preparing, t])

  const savedPercent =
    result && result.originalBytes > 0
      ? Math.max(
          0,
          Math.round(
            ((result.originalBytes - result.cloudBytes) / result.originalBytes) *
              100
          )
        )
      : 0

  return (
    <OLModal show={show} onHide={onClose} size="lg" themed>
      <OLModalHeader closeButton>
        <OLModalTitle>
          {t('download_for_cloud', 'Download for Cloud (< 30 MB)')}
        </OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        <p className="mb-3">
          {t(
            'cloud_export_description',
            'Package only the TeX source files, style sheets, bibliography, and referenced figures required to compile "__projectName__" on Overleaf.com, while excluding draft PDFs, scripts, and unreferenced assets.',
            { projectName }
          )}
        </p>

        {error && (
          <Notification
            type="error"
            content={error}
            className="mb-3"
            isDismissible
            onDismiss={() => setError(null)}
          />
        )}

        <div className="mb-3">
          <div className="fw-semibold mb-2">
            {t('cloud_export_target_size', 'Target archive limit')}
          </div>
          <div className="d-flex gap-2">
            <OLButton
              type="button"
              size="sm"
              variant={targetMaxMb === 25 ? 'primary' : 'secondary'}
              disabled={preparing}
              onClick={() => {
                setTargetMaxMb(25)
                setResult(null)
              }}
            >
              25 MB (Recommended)
            </OLButton>
            <OLButton
              type="button"
              size="sm"
              variant={targetMaxMb === 30 ? 'primary' : 'secondary'}
              disabled={preparing}
              onClick={() => {
                setTargetMaxMb(30)
                setResult(null)
              }}
            >
              30 MB (Overleaf limit)
            </OLButton>
          </div>
        </div>

        <div className="d-flex flex-column gap-2 mb-3">
          <OLFormCheckbox
            id={`cloud-prune-${projectId}`}
            label={t(
              'cloud_export_prune_unused',
              'Include only files required by the main document (skip draft PDFs, scripts, and unreferenced assets)'
            )}
            checked={pruneUnused}
            disabled={preparing}
            onChange={e => {
              setPruneUnused(e.target.checked)
              setResult(null)
            }}
          />
          <OLFormCheckbox
            id={`cloud-compress-${projectId}`}
            label={t(
              'cloud_export_compress_media',
              'Optimize oversized diagrams and images to stay under target size'
            )}
            checked={compressImages}
            disabled={preparing}
            onChange={e => {
              setCompressImages(e.target.checked)
              setResult(null)
            }}
          />
        </div>

        {result && (
          <div className="border rounded p-3 bg-light">
            <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
              <div className="d-flex align-items-center gap-2">
                <MaterialIcon
                  type={result.fitsLimit ? 'check_circle' : 'warning'}
                />
                <strong>
                  {formatBytes(result.originalBytes)} {' -> '}{' '}
                  {formatBytes(result.cloudBytes)}
                </strong>
                {savedPercent > 0 && (
                  <span className="badge bg-success">{savedPercent}% smaller</span>
                )}
              </div>
              <div className="small text-muted">
                {result.keptCount} of {result.originalCount} files kept
                {result.rootDoc ? ` (root: ${result.rootDoc})` : ''}
              </div>
            </div>

            {result.warning && (
              <Notification
                type="warning"
                content={result.warning}
                className="mb-2"
              />
            )}

            <div className="small text-muted d-flex flex-wrap gap-3">
              <span>{result.droppedCount} excluded</span>
              <span>{result.compressedFiles.length} images optimized</span>
              <button
                type="button"
                className="btn btn-link btn-sm p-0 align-baseline"
                onClick={() => setShowDetails(prev => !prev)}
              >
                {showDetails ? 'Hide details' : 'Show file details'}
              </button>
            </div>

            {showDetails && (
              <div
                className="mt-2 pt-2 border-top small"
                style={{ maxHeight: '200px', overflowY: 'auto' }}
              >
                {result.compressedFiles.length > 0 && (
                  <div className="mb-2">
                    <div className="fw-semibold mb-1">Optimized media</div>
                    {result.compressedFiles.map(item => (
                      <div
                        key={item.relPath}
                        className="d-flex justify-content-between gap-2"
                      >
                        <span className="text-truncate">{item.relPath}</span>
                        <span className="text-nowrap text-muted">
                          {formatBytes(item.originalBytes)} {' -> '}{' '}
                          {formatBytes(item.newBytes)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {result.droppedFiles.length > 0 && (
                  <div>
                    <div className="fw-semibold mb-1">Excluded local files</div>
                    {result.droppedFiles.map(item => (
                      <div
                        key={item.relPath}
                        className="d-flex justify-content-between gap-2"
                      >
                        <span className="text-truncate">{item.relPath}</span>
                        <span className="text-nowrap text-muted">
                          {formatReasonLabel(item.reason)} ({formatBytes(item.bytes)})
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </OLModalBody>
      <OLModalFooter>
        <OLButton variant="secondary" onClick={onClose} disabled={preparing}>
          {t('close')}
        </OLButton>
        {!result ? (
          <OLButton
            variant="primary"
            onClick={handlePrepare}
            isLoading={preparing}
            loadingLabel={t('cloud_export_preparing', 'Preparing Cloud ZIP...')}
            leadingIcon="cloud_download"
          >
            {t('cloud_export_prepare_btn', 'Prepare Cloud ZIP')}
          </OLButton>
        ) : (
          <>
            <OLButton
              variant="secondary"
              onClick={handlePrepare}
              isLoading={preparing}
            >
              {t('rebuild', 'Rebuild')}
            </OLButton>
            <OLButton
              variant="primary"
              leadingIcon="download"
              onClick={() => {
                window.location.assign(result.downloadUrl)
                onClose()
              }}
            >
              {t('download_cloud_zip_now', 'Download Cloud ZIP')} ({formatBytes(result.cloudBytes)})
            </OLButton>
          </>
        )}
      </OLModalFooter>
    </OLModal>
  )
}
