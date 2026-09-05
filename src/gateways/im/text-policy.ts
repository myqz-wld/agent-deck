/** Identifiers, JSON keys and single-line control data keep the strict policy. */
export const CONTROL_DATA_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/** Human text permits TAB, LF and CR, consistently with outbound redaction. */
export const FORBIDDEN_TEXT_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
