/**
 * Data models for the Meesho Lister app.
 * These are JSDoc type definitions — no runtime overhead, just editor autocomplete.
 */

/**
 * A single interaction step recorded during the walkthrough.
 * The executor replays these in order to navigate the Meesho form.
 *
 * @typedef {Object} StepConfig
 * @property {'navigate'|'click'|'select'|'type'|'upload'|'wait'} action
 * @property {string} [selector]   - CSS selector for the target element
 * @property {string} [value]      - For 'navigate': URL. For 'select'/'type': the value.
 * @property {string} label        - Human-readable description shown in the live log
 */

/**
 * A form field encountered during the walkthrough.
 * 'ai'     → Gemini generates the value at run time using productDescription + aiPrompt
 * 'fixed'  → same value every time (set during recording)
 * 'sku'    → special: uses skuPattern with a unique random 5-digit suffix
 *
 * @typedef {Object} FieldConfig
 * @property {string} fieldName              - Display name (e.g. "Product Title")
 * @property {string} selector               - CSS selector for the input element
 * @property {'ai'|'fixed'|'sku'} type
 * @property {string} [aiPrompt]             - Instruction sent to Gemini for 'ai' fields
 * @property {string} [fixedValue]           - Pre-defined value for 'fixed' fields
 */

/**
 * The full configuration for one product-type recording.
 * Stored as JSON at paths/<name>/config.json
 *
 * @typedef {Object} PathConfig
 * @property {string}        name               - Human-readable name (e.g. "Faux Fur Cushion Cover")
 * @property {string}        skuPattern         - e.g. "WH_FURR/X"  (X → random 5-digit number)
 * @property {string}        productDescription - Plain-English description used for ALL AI fields
 * @property {StepConfig[]}  steps              - Navigation steps to replay
 * @property {FieldConfig[]} fields             - Fields to fill (ai / fixed / sku)
 * @property {string[]}      sharedImages       - Filenames of images 2-4 (always ["img2.jpg","img3.jpg","img4.jpg"])
 * @property {string}        createdAt          - ISO timestamp
 * @property {string}        updatedAt          - ISO timestamp
 */

// This file has no exports — it exists purely for JSDoc IntelliSense across the project.
