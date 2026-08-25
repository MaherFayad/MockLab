/**
 * ALL message type constants + JSDoc payload typedefs (PLAN.md §2.1, §4, §17.8).
 *
 * OWNER: interceptor-engineer. Read-only for every other agent — if you need a new
 * message type, request it through the orchestrator.
 *
 * Rule §17.8: all async messaging uses these constants. No magic strings anywhere.
 * The typedefs below are the source of truth for the shapes in PLAN.md §4.
 *
 * Filled in at milestone M1.
 */

/**
 * @typedef {Object} RequestSignature
 * @property {string} method
 * @property {string} urlPattern
 * @property {string} [gqlOperation]
 * @property {string} [bodyShape]
 * @property {string} sigId
 */

/**
 * @typedef {Object} CapturedRequest
 * @property {string} sigId
 * @property {RequestSignature} signature
 * @property {string} url
 * @property {number} status
 * @property {string} contentType
 * @property {any} body
 * @property {number} bodyBytes
 * @property {number} ts
 * @property {"fetch"|"xhr"|"document"|"other"} via
 * @property {boolean} mocked
 */

/**
 * @typedef {Object} Change
 * @property {string} id
 * @property {string} origin
 * @property {string} sigId
 * @property {string} path
 * @property {any} value
 * @property {any} originalValue
 * @property {boolean} enabled
 * @property {number} createdAt
 * @property {string} [note]
 * @property {boolean} [probe]
 */

/**
 * @typedef {Object} ElementFingerprint
 * @property {string} css
 * @property {string} textAnchor
 * @property {string[]} attrAnchors
 * @property {number[]} treePath
 */

/**
 * @typedef {Object} Binding
 * @property {string} id
 * @property {string} origin
 * @property {string} sigId
 * @property {string} path
 * @property {ElementFingerprint[]} elements
 * @property {"verified"|"candidate"|"stale"} state
 * @property {number} lastVerifiedAt
 * @property {string[]} observedValues
 * @property {"replace"|"refresh"} probeMode
 */

/**
 * @typedef {Object} Preset
 * @property {string} id
 * @property {string} origin
 * @property {string} name
 * @property {string} emoji
 * @property {Change[]} changes
 * @property {number} createdAt
 * @property {number} [lastAppliedAt]
 */

/** Tag on every MAIN <-> ISOLATED postMessage frame (PLAN.md §2). */
export const MOCKLAB_TAG = '__mocklab';

/** DOM attribute used once, at document_start, to hand the page token to MAIN world. */
export const TOKEN_ATTRIBUTE = 'data-mocklab-token';
