export const message = (e: unknown): string => String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
