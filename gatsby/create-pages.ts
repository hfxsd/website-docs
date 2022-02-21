import { resolve, join } from 'path'
import { existsSync } from 'fs'

import type { CreatePagesArgs } from 'gatsby'
import {
  getStable,
  renameVersionByDoc,
  replacePath,
  genTOCSlug,
  genPDFDownloadURL,
  getRepo,
} from './utils'
import { mdxAstToToc } from './toc'
import sig from 'signale'
import { Root, List } from 'mdast'

import { FrontMatter, Locale, Repo, RepoToc } from 'typing'
import { generateConfig } from './path'

export const createDocs = async ({
  actions: { createPage, createRedirect },
  graphql,
}: CreatePagesArgs) => {
  const template = resolve(__dirname, '../src/templates/doc/index.tsx')

  const docs = await graphql<PageQueryData>(`
    {
      allMdx(
        filter: {
          fileAbsolutePath: { regex: "/^(?!.*TOC).*$/" }
          frontmatter: { draft: { ne: true } }
        }
      ) {
        nodes {
          id
          frontmatter {
            title
            summary
            aliases
          }
          slug
          parent {
            ... on File {
              sourceInstanceName
              relativePath
              name
            }
          }
        }
      }
    }
  `)

  const repoToc = await graphql<TocQuery>(`
    {
      allMdx(filter: { slug: { glob: "**/TOC" } }) {
        nodes {
          mdxAST
          slug
        }
      }
    }
  `)

  if (docs.errors || repoToc.errors) {
    sig.error(docs.errors, repoToc.errors)
  }

  const toc = repoToc.data!.allMdx.nodes.reduce((toc, curr) => {
    const config = generateConfig(curr.slug)
    const res = mdxAstToToc(
      (curr.mdxAST.children.find(node => node.type === 'list')! as List)
        .children,
      config
    )

    // TODO: don't
    toc[curr.slug] = res

    return toc
  }, {} as Record<string, RepoToc>)

  const nodes = docs.data!.allMdx.nodes.map(node => {
    // e.g. => zh/tidb-data-migration/master/benchmark-v1.0-ga => tidb-data-migration/master/benchmark-v1.0-ga
    const slug = node.slug.slice(3)
    const { sourceInstanceName: topFolder, relativePath, name } = node.parent
    const [lang, ...pathWithoutLang] = relativePath.split('/') // [en|zh, pure path with .md]
    const [doc, version, ...rest] = pathWithoutLang
    node.realPath = rest.join('/')

    const slugArray = slug.split('/')
    // e.g. => tidb-data-migration/master/benchmark-v1.0-ga => benchmark-v1.0-ga
    node.pathWithoutVersion = slugArray[slugArray.length - 1]
    node.path = replacePath(slug, name, lang, node.pathWithoutVersion)
    node.repo = getRepo(doc, lang)
    node.ref = version
    node.lang = lang
    node.version = renameVersionByDoc(doc, version)
    node.docVersionStable = JSON.stringify({
      doc,
      version: node.version,
      stable: getStable(doc),
    })

    const filePathInDiffLang = resolve(
      __dirname,
      `../${topFolder}/${lang === 'en' ? 'zh' : 'en'}/${relativePath.slice(3)}`
    )
    node.langSwitchable = existsSync(filePathInDiffLang)

    node.tocSlug = genTOCSlug(node.slug)
    node.downloadURL = genPDFDownloadURL(slug, lang)

    return node
  })

  const versionsMap = nodes.reduce(
    (acc, { lang, version, repo, pathWithoutVersion }) => {
      const key = join(repo, pathWithoutVersion)
      const arr = acc[lang][key]

      if (arr) {
        arr.push(version)
      } else {
        acc[lang][key] = [version]
      }

      return acc
    },
    {
      en: {},
      zh: {},
    }
  )

  nodes.forEach(node => {
    const {
      parent,
      id,
      repo,
      ref,
      lang,
      realPath,
      pathWithoutVersion,
      path,
      docVersionStable,
      langSwitchable,
      tocSlug,
      downloadURL,
      frontmatter,
      body,
      tableOfContents,
    } = node

    createPage({
      path,
      component: template,
      context: {
        id,
        layout: 'doc',
        name: parent.name,
        repo,
        ref,
        lang,
        realPath,
        pathWithoutVersion,
        docVersionStable,
        langSwitchable,
        tocSlug,
        downloadURL,
        frontmatter,
        body,
        tableOfContents,
        versions: versionsMap[lang][join(repo, pathWithoutVersion)],
        toc: toc[tocSlug],
      },
    })

    // create redirects
    if (node.frontmatter.aliases) {
      node.frontmatter.aliases.forEach(fromPath => {
        createRedirect({
          fromPath,
          toPath: path,
          isPermanent: true,
        })
      })
    }
  })
}

interface PageQueryData {
  allMdx: {
    nodes: {
      frontmatter: FrontMatter
      slug: string
      parent: {
        sourceInstanceName: string
        relativePath: string
        name: string
      }
    }[]
  }
}

interface TocQuery {
  allMdx: {
    nodes: {
      mdxAST: Root
      slug: string
    }[]
  }
}
