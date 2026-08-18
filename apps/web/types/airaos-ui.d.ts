/**
 * @airaos/ui ships a CommonJS Tailwind preset with no bundled types. Declaring
 * it as a partial Config keeps tailwind.config.ts type-safe without generating
 * types for a plain configuration object.
 */
declare module '@airaos/ui' {
  import type { Config } from 'tailwindcss';

  const preset: Partial<Config>;
  export default preset;
}
