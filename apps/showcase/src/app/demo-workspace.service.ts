import { Injectable, signal } from '@angular/core';
import { JsonValue } from '@poodlelab/ngrx-offline/core';
import { showcaseRuntimeConfig } from './runtime-config';

export type FailureMode =
  | 'commit_then_disconnect'
  | 'conflict_409'
  | 'precondition_412'
  | 'server_error_500'
  | 'timeout'
  | 'validation_422';

interface WorkspaceCapability {
  readonly workspaceId: string;
  readonly secret: string;
}

const storageKey = 'ngrx-offline-showcase-workspace';

@Injectable()
export class DemoWorkspaceService {
  private readonly capability = readCapability() ?? createCapability();
  private registration: Promise<void> | undefined;

  readonly workspaceId = this.capability.workspaceId;
  readonly apiBaseUrl = showcaseRuntimeConfig.apiBaseUrl;
  readonly expiresAt = signal<string | null>(null);
  readonly nextFailure = signal<FailureMode | null>(readFailureMode());

  constructor() {
    localStorage.setItem(storageKey, JSON.stringify(this.capability));
  }

  authorization(): string {
    return `Bearer ${this.capability.workspaceId}.${this.capability.secret}`;
  }

  async workerPayload(): Promise<JsonValue> {
    await this.ensureRegistered();
    return {
      apiBaseUrl: this.apiBaseUrl,
      authorization: this.authorization(),
    };
  }

  async ensureRegistered(): Promise<void> {
    this.registration ??= this.register().catch((error: unknown) => {
      this.registration = undefined;
      throw error;
    });
    return this.registration;
  }

  armNextFailure(mode: FailureMode | null): void {
    this.nextFailure.set(mode);
    if (mode === null) sessionStorage.removeItem(`${storageKey}:failure`);
    else sessionStorage.setItem(`${storageKey}:failure`, mode);
  }

  consumeNextFailure(): FailureMode | null {
    const mode = this.nextFailure();
    this.armNextFailure(null);
    return mode;
  }

  async armRemoteFailure(idempotencyKey: string, behavior: FailureMode): Promise<void> {
    const response = await fetch(`${this.apiBaseUrl}/v1/test-controls/behaviors`, {
      method: 'POST',
      headers: {
        Authorization: this.authorization(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idempotencyKey,
        behavior,
        ...(behavior === 'timeout' ? { delayMs: 4000 } : {}),
      }),
    });
    if (!response.ok) throw new Error(`Could not arm test behavior (${response.status}).`);
  }

  async resetRemote(): Promise<void> {
    await this.ensureRegistered();
    const response = await fetch(`${this.apiBaseUrl}/v1/demo-workspaces/reset`, {
      method: 'POST',
      headers: { Authorization: this.authorization() },
    });
    if (!response.ok) throw new Error(`Could not reset demo workspace (${response.status}).`);
  }

  private async register(): Promise<void> {
    const response = await fetch(`${this.apiBaseUrl}/v1/demo-workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.capability),
    });
    if (response.status === 409) {
      const existing = await fetch(`${this.apiBaseUrl}/v1/snapshot`, {
        headers: { Authorization: this.authorization() },
      });
      if (existing.ok) return;
    }
    if (!response.ok) throw new Error(`Could not register demo workspace (${response.status}).`);
    const body = (await response.json()) as { expiresAt?: unknown };
    this.expiresAt.set(typeof body.expiresAt === 'string' ? body.expiresAt : null);
  }
}

function createCapability(): WorkspaceCapability {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    workspaceId: crypto.randomUUID(),
    secret: btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''),
  };
}

function readCapability(): WorkspaceCapability | null {
  try {
    const candidate = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as unknown;
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      'workspaceId' in candidate &&
      'secret' in candidate &&
      typeof candidate.workspaceId === 'string' &&
      typeof candidate.secret === 'string'
    ) {
      return { workspaceId: candidate.workspaceId, secret: candidate.secret };
    }
  } catch {
    // A malformed local capability is replaced with a new anonymous workspace.
  }
  return null;
}

function readFailureMode(): FailureMode | null {
  const value = sessionStorage.getItem(`${storageKey}:failure`);
  const modes: readonly string[] = [
    'commit_then_disconnect',
    'conflict_409',
    'precondition_412',
    'server_error_500',
    'timeout',
    'validation_422',
  ];
  return modes.includes(value ?? '') ? (value as FailureMode) : null;
}
