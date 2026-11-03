import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'node:fs';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), {
      name: 'keep-original-documents-private',
      buildStart() {
        const inspect = (directory: string) => {
          if (!fs.existsSync(directory)) return;
          for (const item of fs.readdirSync(directory, {withFileTypes:true})) {
            const itemPath=path.join(directory,item.name);
            if (item.isDirectory()) inspect(itemPath);
            else if (/\.pdf$/i.test(item.name)) this.error('Original PDFs must stay in Telegram or private/, never public/.');
          }
        };
        inspect(path.resolve(process.cwd(),'public'));
      },
    }],
    resolve: {
      alias: {
        '@': path.resolve(process.cwd(), '.'),
      },
    },
    server: {
      fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/private/**', '**/*.pdf'] },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
