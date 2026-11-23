/**
 * Error con mensaje amigable en español para mostrar al usuario final.
 * `code` permite distinguir el motivo en logs / tests.
 */
export class UserFacingError extends Error {
  constructor(code, userMessage, { cause } = {}) {
    super(userMessage, { cause });
    this.name = 'UserFacingError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

export const ErrorCodes = Object.freeze({
  INVALID_URL: 'INVALID_URL',
  NOT_FOUND: 'NOT_FOUND',
  PRIVATE: 'PRIVATE',
  NO_MEDIA: 'NO_MEDIA',
  TOO_LARGE: 'TOO_LARGE',
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  CONVERSION: 'CONVERSION',
});

/**
 * Convierte cualquier error en un mensaje corto para el usuario.
 */
export function toUserMessage(err) {
  if (err instanceof UserFacingError) return err.userMessage;
  return 'Ocurrió un error inesperado al generar el sticker. Probá de nuevo en un rato.';
}
