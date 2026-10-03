// Run before application imports so icons need no injected style elements.
import { config as iconConfig } from '@fortawesome/fontawesome-svg-core'
import '@fortawesome/fontawesome-svg-core/styles.css'

iconConfig.autoAddCss = false
