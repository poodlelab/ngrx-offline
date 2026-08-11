import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { Actions } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import {
  OfflineOutboxActions,
  OfflineWorkerBridge,
  offlineRef,
  selectOfflineBlockedCount,
  selectOfflineHydrated,
  selectOfflineOperations,
  selectOfflinePendingCount,
  selectOfflineStorageHealth,
  selectOfflineSyncing,
} from '@poodlelab/ngrx-offline';
import { filter } from 'rxjs';
import { DemoWorkspaceService, FailureMode } from './demo-workspace.service';
import {
  dayReflectionMutation,
  memoryMutation,
  placeVisitMutation,
  travelDayMutation,
  tripMutation,
} from './offline-definitions';
import { ShowcaseConnectivity } from './showcase-connectivity';
import { ShowcaseActions, ShowcaseEntity, showcaseFeature } from './showcase.store';

type Section = 'dashboard' | 'learn' | 'sync' | 'workspace';
type Theme = 'dark' | 'light';

interface HistoryItem {
  readonly id: number;
  readonly label: string;
  readonly time: number;
  readonly tone: 'blocked' | 'neutral' | 'success';
}

@Component({
  selector: 'ngx-offline-showcase',
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  private readonly store = inject(Store);
  private readonly actions = inject(Actions);
  readonly connectivity = inject(ShowcaseConnectivity);
  readonly workspace = inject(DemoWorkspaceService);
  private readonly workerBridge = inject(OfflineWorkerBridge);

  readonly section = signal<Section>('dashboard');
  readonly mobileNavOpen = signal(false);
  readonly theme = signal<Theme>(preferredTheme());
  readonly announcement = signal('Atlas Journal ready.');
  readonly copiedSnippet = signal<string | null>(null);
  readonly paused = signal(false);
  readonly history = signal<readonly HistoryItem[]>([]);

  readonly entities = this.store.selectSignal(showcaseFeature.selectEntities);
  readonly operationsRecord = this.store.selectSignal(selectOfflineOperations);
  readonly pendingCount = this.store.selectSignal(selectOfflinePendingCount);
  readonly blockedCount = this.store.selectSignal(selectOfflineBlockedCount);
  readonly syncing = this.store.selectSignal(selectOfflineSyncing);
  readonly hydrated = this.store.selectSignal(selectOfflineHydrated);
  readonly storageHealth = this.store.selectSignal(selectOfflineStorageHealth);
  readonly online = toSignal(this.connectivity.changes, {
    initialValue: this.connectivity.isOnline(),
  });
  readonly storageErrorMessage = computed(() => {
    const health = this.storageHealth();
    return health.status === 'error' ? health.message : null;
  });
  readonly operations = computed(() =>
    Object.values(this.operationsRecord()).sort((left, right) => left.createdAt - right.createdAt),
  );
  readonly syncedCount = computed(
    () => this.entities().filter((entity) => entity.state === 'synced').length,
  );
  readonly progress = computed(() => {
    if (!this.hydrated()) return 0;
    if (this.entities().length === 0) return 1;
    if (!this.online()) return 2;
    if (this.pendingCount() + this.blockedCount() > 0) return 3;
    return 4;
  });
  readonly chain = computed(() => {
    const order: ShowcaseEntity['kind'][] = [
      'Trip',
      'Travel day',
      'Place visit',
      'Memory',
      'Day reflection',
    ];
    return order.flatMap((kind) => this.entities().filter((entity) => entity.kind === kind));
  });
  readonly routeChain = computed(() =>
    this.chain().filter((entity) => entity.kind !== 'Day reflection'),
  );
  readonly reflectionChain = computed(() =>
    this.chain().filter((entity) => entity.kind === 'Day reflection'),
  );

  readonly definitionSnippet = `const createTravelDay = defineOfflineCreate({
  kind: 'journal.travel-day.create',
  entity: 'travel-day',
  request: (input, ctx) => ({
    method: 'POST',
    url: '/v1/travel-days',
    body: {
      clientId: input.clientId,
      tripId: ctx.resolve(input.trip),
      date: input.date,
      title: input.title,
      summary: input.summary
    }
  })
});`;

  readonly providerSnippet = `bootstrapApplication(AppComponent, {
  providers: [
    provideStore(),
    provideOfflineOutbox(() => ({
      databaseName: 'atlas-journal-outbox-v1',
      scope: () => workspace.workspaceId,
      mutations: showcaseMutations,
      transport: inject(ShowcaseTransport),
      connectivity: inject(ShowcaseConnectivity)
    })),
    provideOfflineWorkerBridge(() => ({
      payload: () => workspace.workerPayload()
    }))
  ]
});`;

  readonly workerSnippet = `importScripts('./ngsw-worker.js');

const executor = new WorkerOutboxExecutor({
  databaseName: 'atlas-journal-outbox-v1',
  definitions: operationDefinitions,
  transport: new FetchOperationTransport({
    enhanceRequest: addFreshAuthorization
  }),
  canReplay: scope => credentialBroker.has(scope),
  notifier: new WorkerClientNotifier(self.clients)
});

registerOfflineWorkerHandlers({ scope: self, executor });`;

  readonly reducerSnippet = `on(travelDayMutation.queued, (state, { input, operationId }) => ({
  ...state,
  // Optimism begins only after IndexedDB committed the operation.
  travelDays: [...state.travelDays, {
    ...input,
    operationId,
    syncState: 'queued'
  }]
}));`;

  constructor() {
    effect(() => {
      document.documentElement.dataset['theme'] = this.theme();
      localStorage.setItem('ngrx-offline-showcase-theme', this.theme());
    });
    this.actions
      .pipe(
        filter(
          (action) =>
            action.type.startsWith('[Offline]') || action.type.startsWith('[NgRx Offline'),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((action) => {
        const label = lifecycleLabel(action.type);
        const tone: HistoryItem['tone'] = action.type.includes('Succeeded')
          ? 'success'
          : action.type.includes('Blocked') || action.type.includes('Failed')
            ? 'blocked'
            : 'neutral';
        this.history.update((items) =>
          [{ id: Date.now() + Math.random(), label, time: Date.now(), tone }, ...items].slice(
            0,
            12,
          ),
        );
      });
  }

  navigate(section: Section): void {
    this.section.set(section);
    this.mobileNavOpen.set(false);
    globalThis.scrollTo({ top: 0, behavior: 'smooth' });
  }

  toggleTheme(): void {
    this.theme.update((theme) => (theme === 'light' ? 'dark' : 'light'));
  }

  setOffline(offline: boolean): void {
    this.connectivity.setSimulatedOffline(offline);
    this.announcement.set(
      offline
        ? 'Simulation is offline. New journal moments will be kept on this device.'
        : 'Connection restored. Synchronization started.',
    );
  }

  createScenario(event: SubmitEvent): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const tripId = crypto.randomUUID();
    const travelDayId = crypto.randomUUID();
    const placeVisitId = crypto.randomUUID();
    const trip = offlineRef('trip', tripId);
    const travelDay = offlineRef('travel-day', travelDayId);
    const placeVisit = offlineRef('place-visit', placeVisitId);
    this.store.dispatch(
      tripMutation.requested({
        input: {
          clientId: tripId,
          title: field(form, 'trip', 'Lisbon in the margins'),
          destination: field(form, 'destination', 'Lisbon, Portugal'),
          startDate: field(form, 'date', '2026-09-18'),
        },
      }),
    );
    this.store.dispatch(
      travelDayMutation.requested({
        input: {
          clientId: travelDayId,
          trip,
          date: field(form, 'date', '2026-09-18'),
          title: field(form, 'travelDay', 'A slow morning in Alfama'),
          summary: 'Tram bells, tiled lanes, and a long view toward the Tagus.',
        },
      }),
    );
    this.store.dispatch(
      placeVisitMutation.requested({
        input: {
          clientId: placeVisitId,
          travelDay,
          name: field(form, 'placeVisit', 'Miradouro da Senhora do Monte'),
          city: 'Lisbon',
          countryCode: 'PT',
          arrivedAt: '2026-09-18T08:40:00+01:00',
        },
      }),
    );
    const memories = [
      {
        title: 'The city before breakfast',
        body: 'Soft light moved across the roofs while the first tram climbed the hill.',
        category: 'place' as const,
      },
      {
        title: 'Pastéis still warm',
        body: 'Cinnamon on my fingers and espresso balanced on the smallest table.',
        category: 'taste' as const,
      },
      {
        title: 'A bell around the corner',
        body: 'I heard the tram before it appeared between the blue-tiled buildings.',
        category: 'sound' as const,
      },
    ];
    memories.forEach((memory, sortOrder) =>
      this.store.dispatch(
        memoryMutation.requested({
          input: {
            clientId: crypto.randomUUID(),
            placeVisit,
            ...memory,
            sortOrder,
          },
        }),
      ),
    );
    this.store.dispatch(
      dayReflectionMutation.requested({
        input: {
          clientId: crypto.randomUUID(),
          travelDay,
          body: field(
            form,
            'dayReflection',
            'The best parts of today were the ones I had not put on the map.',
          ),
          mood: 'radiant',
          weather: 'Warm with a river breeze',
          clientCreatedAt: '2026-09-18T19:20:00+01:00',
        },
      }),
    );
    this.announcement.set('Seven related records are being committed to the durable outbox.');
    this.navigate('sync');
  }

  addDayReflection(): void {
    const day = this.entities().find((entity) => entity.kind === 'Travel day');
    if (day === undefined) return;
    this.store.dispatch(
      dayReflectionMutation.requested({
        input: {
          clientId: crypto.randomUUID(),
          travelDay: offlineRef('travel-day', day.clientId),
          body: 'One more detail before sleep: the city sounded different after the rain.',
          mood: 'calm',
          weather: 'Light evening rain',
          clientCreatedAt: new Date().toISOString(),
        },
      }),
    );
    this.announcement.set('A new day reflection was committed to the outbox.');
  }

  syncNow(): void {
    this.store.dispatch(OfflineOutboxActions.syncNow());
    this.announcement.set('Synchronization requested.');
  }

  async syncInWorker(): Promise<void> {
    this.announcement.set('Handing the durable queue to the service worker…');
    const executor = await this.workerBridge.requestSync();
    this.announcement.set(
      executor === 'worker'
        ? 'Worker sync started. You may close this page while it finishes.'
        : 'No active worker was available, so foreground sync completed safely.',
    );
  }

  togglePause(): void {
    if (this.paused()) {
      this.store.dispatch(OfflineOutboxActions.resumeScope({ scope: this.workspace.workspaceId }));
      this.paused.set(false);
      this.announcement.set('Workspace queue resumed.');
    } else {
      this.store.dispatch(OfflineOutboxActions.pauseScope({ scope: this.workspace.workspaceId }));
      this.paused.set(true);
      this.announcement.set('Workspace queue paused. Durable work is preserved.');
    }
  }

  retry(operationId: string): void {
    this.store.dispatch(OfflineOutboxActions.retry({ operationId }));
    this.announcement.set('Blocked operation moved back to the queue.');
  }

  cancel(operationId: string): void {
    this.store.dispatch(OfflineOutboxActions.cancel({ operationId }));
    this.announcement.set('Cancellation requested. Dependents are protected.');
  }

  discard(operationId: string): void {
    this.store.dispatch(OfflineOutboxActions.discard({ operationId }));
    this.store.dispatch(ShowcaseActions.discardEntity({ operationId }));
    this.announcement.set('Operation and its optimistic journal record were discarded.');
  }

  armFailure(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.workspace.armNextFailure(value === '' ? null : (value as FailureMode));
    this.announcement.set(
      value === ''
        ? 'Failure simulation cleared.'
        : 'The next request will use the selected deterministic failure.',
    );
  }

  async resetWorkspace(): Promise<void> {
    if (this.connectivity.isOnline()) {
      try {
        await this.workspace.resetRemote();
      } catch {
        this.announcement.set('The remote reset could not be reached; local cleanup continued.');
      }
    }
    this.store.dispatch(
      OfflineOutboxActions.logoutScope({ scope: this.workspace.workspaceId, confirmed: true }),
    );
    this.store.dispatch(ShowcaseActions.resetView());
    this.history.set([]);
    this.paused.set(false);
    this.announcement.set('Workspace view and durable queue reset.');
    this.navigate('dashboard');
  }

  async copy(name: string, value: string): Promise<void> {
    await navigator.clipboard.writeText(value);
    this.copiedSnippet.set(name);
    this.announcement.set(`${name} code copied.`);
    globalThis.setTimeout(() => this.copiedSnippet.set(null), 1800);
  }

  shortId(value: string): string {
    return value.slice(0, 8);
  }

  operationName(kind: string): string {
    return kind.replace('journal.', '').replace('.create', '').replaceAll('-', ' ');
  }

  time(value: number): string {
    return new Intl.DateTimeFormat('en', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(value);
  }

  nextAttempt(value: number | null): string {
    if (value === null || value <= Date.now()) return 'Ready now';
    return `Retry ${new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(
      Math.max(1, Math.round((value - Date.now()) / 1000)),
      'second',
    )}`;
  }
}

function field(form: FormData, name: string, fallback: string): string {
  const value = form.get(name);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function preferredTheme(): Theme {
  const stored = localStorage.getItem('ngrx-offline-showcase-theme');
  if (stored === 'dark' || stored === 'light') return stored;
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function lifecycleLabel(type: string): string {
  return type
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/^journal\./, '')
    .replaceAll('.', ' · ');
}
