import { TransportErrorCategory } from './contracts';

/**
 * A stable, actionable error raised for an invalid operation definition.
 *
 * @alpha
 */
export class OfflineConfigurationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OfflineConfigurationError';
  }
}

/**
 * A stable, actionable error raised when durable input is not JSON compatible.
 *
 * @alpha
 */
export class OfflineInputError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'OfflineInputError';
  }
}

/**
 * A transport error whose category is safe for durable failure classification.
 *
 * @alpha
 */
export class OfflineTransportError extends Error {
  constructor(
    readonly category: TransportErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = 'OfflineTransportError';
  }
}
