/** Private process: sandbox-runtime's singleton and environment belong to one agent. */
import { z } from 'zod';
import { SandboxRuntimeProvider } from './runtime.js';
import type { SandboxPolicy, SandboxSpawnSpec, SandboxExecSpec, SandboxCommandFailure } from '../types.js';

const requestSchema = z.object({
  id: z.number().int().nonnegative(),
  method: z.enum(['initialize', 'wrapSpawn', 'wrapExec', 'classifyFailure', 'notifyWrappedSpawnFailure', 'dispose', 'networkAnswer']),
  payload: z.unknown().optional(),
});
let provider: SandboxRuntimeProvider | undefined;
let sequence = 0;
const network = new Map<number, (allow: boolean) => void>();
const send = (message: unknown) => { if (process.connected) process.send?.(message); };

process.on('message', (raw) => {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return;
  const { id, method, payload } = parsed.data;
  if (method === 'networkAnswer') {
    network.get(id)?.(payload === true);
    network.delete(id);
    return;
  }
  void (async () => {
    try {
      let result: unknown;
      if (method === 'initialize') {
        const options = z.object({ policy: z.unknown(), credentialEnvVars: z.array(z.string()).optional() }).parse(payload);
        provider ??= new SandboxRuntimeProvider({
          ...(options.credentialEnvVars ? { credentialEnvVars: options.credentialEnvVars } : {}),
          onNetworkRequest: (request) => new Promise<boolean>((resolve) => {
            const requestId = ++sequence;
            network.set(requestId, resolve);
            send({ event: 'network', id: requestId, request });
          }),
          onDegraded: () => { if (provider) send({ event: 'status', status: provider.status() }); },
        });
      }
      if (!provider) throw new Error('Sandbox worker is not initialized');
      switch (method) {
        case 'initialize': result = await provider.initialize((payload as { policy: SandboxPolicy }).policy); break;
        case 'wrapSpawn': result = await provider.wrapSpawn(payload as SandboxSpawnSpec); break;
        case 'wrapExec': result = await provider.wrapExec(payload as SandboxExecSpec); break;
        case 'classifyFailure': result = provider.classifyFailure(payload as SandboxCommandFailure); break;
        case 'notifyWrappedSpawnFailure': provider.notifyWrappedSpawnFailure(payload as { message: string }); break;
        case 'dispose':
          for (const resolve of network.values()) resolve(false);
          network.clear();
          await provider.dispose();
          break;
      }
      send({ id, result, status: provider.status() });
    } catch (error) {
      send({ id, error: error instanceof Error ? error.message : String(error), status: provider?.status() });
    }
  })();
});
process.on('disconnect', () => {
  for (const resolve of network.values()) resolve(false);
  void provider?.dispose().catch(() => {}).finally(() => process.exit(0));
  if (!provider) process.exit(0);
});
