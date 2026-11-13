import en from './translations/en'
import i18next, { type i18n as I18n } from 'i18next'

// Its own instance, as Sorlo Forms has, so a host's i18next and its settings are left alone
const i18n: I18n = i18next.createInstance()

i18n.init({
  resources: { en },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export default i18n
