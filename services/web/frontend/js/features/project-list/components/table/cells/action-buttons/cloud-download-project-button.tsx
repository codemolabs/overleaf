import { memo, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import CloudExportModal from '@/shared/components/cloud-export-modal'
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

export default memo(CloudDownloadProjectButton)
