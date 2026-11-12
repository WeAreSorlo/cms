import { inputs } from '@sorlo/forms'
import type {
  InputCategory,
  InputDescription,
  InputFormatValue,
  InputName,
  InputOptionFields,
  InputTypeValue,
  InputValidateValue,
} from '@sorlo/forms'

// Markdown is text, so the field takes the textarea's settings and checks, with its messages

export const name: InputName = () => 'Markdown'

export const description: InputDescription = () => 'Text written in Markdown, with format buttons and a preview.'

export const category: InputCategory = () => 'Standard'

export const optionFields: InputOptionFields = (fields) => inputs.textarea.optionFields(fields)

export const validateValue: InputValidateValue = (value, schema) => inputs.textarea.validateValue(value, schema)

export const typeValue: InputTypeValue = () => 'string'

export const formatValue: InputFormatValue = (value, schema) => inputs.textarea.formatValue(value, schema)
