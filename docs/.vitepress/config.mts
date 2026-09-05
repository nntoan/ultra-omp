import { defineConfig } from 'vitepress';
export default defineConfig({

  title: 'Ultra OMP',
  description: 'Native OMP extensions and a disposable installer.',
  lang: 'en-US',
  site: 'https://ultra-omp.nntoan.com',
  cleanUrls: false,
  srcDir: '.',
  base: '/',
  sitemap: { hostname: 'https://ultra-omp.nntoan.com' },
  themeConfig: {
    nav: [
      { text: 'Overview', link: '/' },
      { text: 'Installation', link: '/installation' },
      { text: 'Plugins', link: '/plugins' },
      { text: 'Agent Skills', link: '/agent-skills' }
    ],
    sidebar: [
      { text: 'Overview', link: '/' },
      { text: 'Installation', link: '/installation' },
      { text: 'Plugins', link: '/plugins' },
      { text: 'Agent Skills', link: '/agent-skills' }
    ],
    editLink: { pattern: 'https://github.com/nntoan/ultra-omp/edit/main/docs/:path' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/nntoan/ultra-omp' }]
  }
});
