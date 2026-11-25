import { memo, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import CloudExportModal from '@/shared/components/cloud-export-modal'
import OLIconButton from '@/shared/components/ol/ol-icon-button'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import { Project } from '../../../../../../../../types/project/dashboard/api'

type CloudDownloadProjectButtonProps = {
  project: Project
  children: (text: string, openModal: () => void) => React.ReactElement
}

function CloudDownloadProjectButton({
  project,
  children,
}: CloudDownloadProjectButtonProps) {
  const { t } = useTranslation()
  const [showModal, setShowModal] = useState(false)
  const text = t('download_for_cloud', 'Download for Cloud (< 30 MB)')

  const handleOpen = useCallback(() => {
    setShowModal(true)
  }, [])

  return (
    <>
      {children(text, handleOpen)}
      <CloudExportModal
        projectId={project.id}
        projectName={project.name}
        show={showModal}
        onClose={() => setShowModal(false)}
      />
    </>
  )
}

const CloudDownloadProjectButtonTooltip = memo(
  function CloudDownloadProjectButtonTooltip({
    project,
    variant = 'link',
    className = 'action-btn',
    placement = 'top',
  }: Pick<CloudDownloadProjectButtonProps, 'project'> & {
    variant?: 'link' | 'secondary'
    className?: string
    placement?: 'top' | 'bottom'
  }) {
    return (
      <CloudDownloadProjectButton project={project}>
        {(text, openModal) => (
          <OLTooltip
            key={`tooltip-cloud-download-project-${project.id}`}
            id={`cloud-download-project-${project.id}-${variant}`}
            description={text}
            overlayProps={{ placement, trigger: ['hover', 'focus'] }}
          >
            <span>
              <OLIconButton
                onClick={openModal}
                variant={variant}
                accessibilityLabel={text}
                className={className}
                icon="cloud_download"
              />
            </span>
          </OLTooltip>
        )}
      </CloudDownloadProjectButton>
    )
  }
)

export default memo(CloudDownloadProjectButton)
export { CloudDownloadProjectButtonTooltip }
