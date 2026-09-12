import { defineConfig } from 'vitepress';
export default defineConfig({

  title: 'Ultra OMP',
  description: 'Native OMP extensions and a disposable installer.',
  lang: 'en-US',
  site: 'https://nntoan.com/ultra-omp/',
  cleanUrls: false,
  srcDir: '.',
  base: '/ultra-omp/',
  sitemap: { hostname: 'https://nntoan.com/ultra-omp/' },
  themeConfig: {
    nav: [
      { text: 'Overview', link: '/' },
      { text: 'Installation', link: '/installation' },
      { text: 'Plugins', link: '/plugins' },
      { text: 'Proflow', link: '/agent-skills' }
    ],
    sidebar: [
      { text: 'Overview', link: '/' },
      { text: 'Installation', link: '/installation' },
      { text: 'Plugins', link: '/plugins' },
      { text: 'Proflow', link: '/agent-skills' },
      { text: 'Release runbook', link: '/release-runbook' }
    ],
    editLink: { pattern: 'https://github.com/nntoan/ultra-omp/edit/main/docs/:path' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/nntoan/ultra-omp' }]
  }
});
