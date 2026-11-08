# Wellzz blog automation

Writes a researched post for the [Wellzz blog](https://wellzz.app/blog/) every 3 days and shares it to Facebook and Instagram.
It runs on GitHub Actions (`.github/workflows/blog-post.yml`), four tries a day, using free services only:
Gemini's free tier for writing, Europe PMC for the studies each post cites, and Pixabay for photos.

The site publishes the post through its blog API; this repo holds only the automation.

Secrets (Settings → Secrets and variables → Actions): `SITE_URL`, `BLOG_AUTOMATION_TOKEN`, `GEMINI_API_KEY`,
`PIXABAY_API_KEY`, `META_PAGE_TOKEN`.

```sh
npm ci
npm test
```
