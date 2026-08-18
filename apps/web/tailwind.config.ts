import type { Config } from 'tailwindcss';
import preset from '@airaos/ui';

const config: Config = {
  presets: [preset as Config],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './features/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  // Environment tone utilities are generated from the CSS variables in
  // @airaos/ui/tokens.css so an environment always renders identically.
  safelist: [
    { pattern: /^env-(development|testing|staging|production)$/ },
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
