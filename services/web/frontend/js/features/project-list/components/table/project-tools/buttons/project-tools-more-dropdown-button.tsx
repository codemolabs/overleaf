import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import CopyProjectMenuItem from '../menu-items/copy-project-menu-item'
import RenameProjectMenuItem from '../menu-items/rename-project-menu-item'
import CloudDownloadProjectButton from '../../cells/action-buttons/cloud-download-project-button'
import { useProjectListContext } from '../../../../context/project-list-context'
import {
  OLDropdown,
  OLDropdownItem,
  OLDropdownMenu,
  OLDropdownToggle,
} from '@/shared/components/ol/ol-dropdown-menu'

function ProjectToolsMoreDropdownButton() {
  const { t } = useTranslation()
  const { selectedProjects } = useProjectListContext()

  return (
    <OLDropdown align="end">
      <OLDropdownToggle id="project-tools-more-dropdown" variant="secondary">
        {t('more')}
      </OLDropdownToggle>
      <OLDropdownMenu
        flip={false}
        data-testid="project-tools-more-dropdown-menu"
      >
        <RenameProjectMenuItem />
        <CopyProjectMenuItem />
        {selectedProjects.length === 1 && (
          <CloudDownloadProjectButton project={selectedProjects[0]}>
            {(text, openCloudModal) => (
              <li role="none">
                <OLDropdownItem
                  as="button"
                  tabIndex={-1}
                  onClick={openCloudModal}
                  leadingIcon="cloud_download"
                >
                  {text}
                </OLDropdownItem>
              </li>
            )}
          </CloudDownloadProjectButton>
        )}
      </OLDropdownMenu>
    </OLDropdown>
  )
}

export default memo(ProjectToolsMoreDropdownButton)
