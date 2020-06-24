import { uniqBy, List } from "lodash"
import { IGatsbyState } from "../redux/types"
import { Stats } from "webpack"
import { map } from "bluebird"

interface ICompilation {
  modules: IModule[]
}

interface IReason extends Omit<Stats.Reason, "module"> {
  module: IModule
}

interface IModule extends Omit<Stats.FnModules, "identifier" | "reasons"> {
  hasReasons: () => boolean
  resource?: string
  identifier: () => string
  reasons: IReason[]
}

const mapComponentsToStaticQueryHashes = (
  staticQueryComponents: IGatsbyState["staticQueryComponents"]
): Map<string, string> => {
  const map = new Map()

  staticQueryComponents.forEach(({ componentPath, hash }) => {
    map.set(componentPath, hash)
  })

  return map
}

/* This function takes the current Redux state and a compilation
 * object from webpack and returns a map of unique templates
 * to static queries included in each (as hashes).
 *
 * This isn't super straightforward because templates may include
 * deep component trees with static queries present at any depth.
 * This is why it is necessary to map templates to all their (user land and node_modules)
 * dependencies first and then map those dependencies to known static queries.
 *
 * Also, Gatsby makes it possible to wrap an entire site or page with a layout
 * or other component(s) via the wrapRootElement and wrapPageElement APIs. These must
 * also be handled when computing static queries for a page.
 *
 * Let's go through the implementation step by step.
 */
export function mapTemplatesToStaticQueryHashes(
  reduxState: IGatsbyState,
  compilation: ICompilation
): Map<string, Array<number>> {
  /* The `staticQueryComponents` slice of state is useful because
   * it is a pre extracted collection of all static queries found in a Gatsby site.
   * This lets us traverse upwards from those to templates that
   * may contain components that contain them.
   * Note that this upward traversal is much shallower (and hence more performant)
   * than an equivalent downward one from an entry point.
   */
  const { components, staticQueryComponents } = reduxState
  const { modules } = compilation

  /* When we traverse upwards, we need to know where to stop. We'll call these terminal nodes.
   * `async-requires.js` is the entry point for every page, while `api-runner-browser-plugins.js`
   * is the one for `gatsby-browser` (where one would use wrapRootElement or wrapPageElement APIs)
   */
  const terminalNodes = [
    `.cache/api-runner-browser-plugins.js`,
    `.cache/async-requires.js`,
  ]

  /* We call the queries included above a page (via wrapRootElement or wrapPageElement APIs)
   * global queries. For now, we include these in every single page for simplicity. Overhead
   * here is not much since we are storing hashes (that reference separate result files)
   * as opposed to inlining results. We may move these to app-data perhaps in the future.
   */
  const globalStaticQueries = new Set<string>()

  /* This function takes a webpack module corresponding
   * to the file containing a static query and returns
   * a Set of strings, each an absolute path of a dependent
   * of this module
   */
  const getDeps = (mod: IModule): Set<string> => {
    const staticQueryModuleComponentPath = mod.resource
    const result = new Set<string>()

    // This is the body of the recursively called function
    const getDepsFn = (m: IModule): Set<string> => {
      // Reasons in webpack are literally reasons of why this module was included in the tree
      const hasReasons = m.hasReasons()

      // Is this node one of our known terminal nodes? See explanation above
      const isTerminalNode = terminalNodes.some(terminalNode =>
        m?.resource?.includes(terminalNode)
      )

      // Exit if we don't have any reasons or we have reached a possible terminal node
      if (!hasReasons || isTerminalNode) {
        return result
      }

      // These are non terminal dependents and hence modules that need
      // further upward traversal
      const nonTerminalDependents: List<IModule> = m.reasons
        .filter(r => {
          const dependentModule = r.module
          const isTerminal = terminalNodes.some(terminalNode =>
            dependentModule?.resource?.includes(terminalNode)
          )
          return !isTerminal
        })
        .map(r => r.module)
        .filter(Boolean)

      const uniqDependents = uniqBy(nonTerminalDependents, d => d?.identifier())

      for (const uniqDependent of uniqDependents) {
        if (uniqDependent.resource) {
          result.add(uniqDependent.resource)
        }

        if (
          uniqDependent?.resource?.includes(`gatsby-browser.js`) &&
          staticQueryModuleComponentPath
        ) {
          globalStaticQueries.add(staticQueryModuleComponentPath)
        }
        getDepsFn(uniqDependent)
      }

      return result
    }

    return getDepsFn(mod)
  }

  const mapOfStaticQueryComponentsToDependants = new Map()

  // For every known static query, we get its dependents.
  staticQueryComponents.forEach(({ componentPath }) => {
    const staticQueryComponentModule = modules.find(
      m => m.resource === componentPath
    )

    const dependants = staticQueryComponentModule
      ? getDeps(staticQueryComponentModule)
      : new Set()

    mapOfStaticQueryComponentsToDependants.set(componentPath, dependants)
  })

  const mapOfComponentsToStaticQueryHashes = mapComponentsToStaticQueryHashes(
    staticQueryComponents
  )

  const globalStaticQueryHashes: string[] = []

  globalStaticQueries.forEach(q => {
    const hash = mapOfComponentsToStaticQueryHashes.get(q)
    if (hash) {
      globalStaticQueryHashes.push(hash)
    }
  })

  // For every known page, we get queries
  const mapOfTemplatesToStaticQueryHashes = new Map()

  components.forEach(page => {
    const staticQueryHashes = [...globalStaticQueryHashes]

    // Does this page contain an inline static query?
    if (mapOfComponentsToStaticQueryHashes.has(page.componentPath)) {
      const hash = mapOfComponentsToStaticQueryHashes.get(page.componentPath)
      if (hash) {
        staticQueryHashes.push(hash)
      }
    }

    // Check dependencies
    mapOfStaticQueryComponentsToDependants.forEach(
      (setOfDependants, staticQueryComponentPath) => {
        if (setOfDependants.has(page.componentPath)) {
          const hash = mapOfComponentsToStaticQueryHashes.get(
            staticQueryComponentPath
          )
          if (hash) {
            staticQueryHashes.push(hash)
          }
        }
      }
    )

    mapOfTemplatesToStaticQueryHashes.set(
      page.componentPath,
      staticQueryHashes.sort()
    )
  })

  return mapOfTemplatesToStaticQueryHashes
}
