# News for Maris

Every copy of Maris that is online shows the posts in this folder on its **Updates & news** page.
Maris reads them from the `main` branch, a few times a day.

## Adding a post

Put a Markdown file here, commit and push. That is all: no list to update.

- The file name starts with the date: `2026-11-05-faster-pictures.md`.
- The first `# heading` is the post's title; the first paragraph is the summary in the list.
- The first picture is the cover in the list. Put pictures in `images/` and write paths
  relative to this folder: `![The new tab](images/skills-tab.png)`.

Optional front matter at the top overrides any of that:

```markdown
---
title: Maris 0.3.0
date: 2026-12-01
summary: Faster pictures and a new Models page.
kind: update        # news, update or tip
version: 0.3.0      # for update notes
cover: images/030.png
pinned: true
author: MarySue
---
```

Posts written on the Admin page inside Maris live in `posts/`, with their pictures in
`images/<post id>/`, and are listed in `index.json`. Files added to `posts/` by hand are posts
too. This README is not a post.
