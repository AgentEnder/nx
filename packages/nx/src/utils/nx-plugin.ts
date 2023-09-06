import { existsSync } from 'fs';
import * as path from 'path';
import {
  ProjectFileMap,
  ProjectGraph,
  ProjectGraphExternalNode,
} from '../config/project-graph';
import { toProjectName } from '../config/workspaces';

import { workspaceRoot } from './workspace-root';
import { readJsonFile } from '../utils/fileutils';
import {
  PackageJson,
  readModulePackageJsonWithoutFallbacks,
} from './package-json';
import {
  registerTranspiler,
  registerTsConfigPaths,
} from '../plugins/js/utils/register';
import {
  ProjectConfiguration,
  ProjectsConfigurations,
} from '../config/workspace-json-project-json';
import { logger } from './logger';
import {
  createProjectRootMappingsFromProjectConfigurations,
  findProjectForPath,
} from '../project-graph/utils/find-project-for-path';
import { normalizePath } from './path';
import { dirname, join } from 'path';
import { getNxRequirePaths } from './installation-directory';
import { readTsConfig } from '../plugins/js/utils/typescript';
import { NxJsonConfiguration } from '../config/nx-json';

import type * as ts from 'typescript';
import { retrieveProjectConfigurationsWithoutPluginInference } from '../project-graph/utils/retrieve-workspace-files';
import { NxPluginV1 } from './nx-plugin.deprecated';
import { ProjectGraphDependencyWithFile } from '../project-graph/project-graph-builder';
import { combineGlobPatterns } from './globs';
import {
  NxAngularJsonPlugin,
  shouldMergeAngularProjects,
} from '../adapter/angular-json';
import { getNxPackageJsonWorkspacesPlugin } from '../../plugins/package-json-workspaces';
import { CreateProjectJsonProjectsPlugin } from '../plugins/project-json/build-nodes/project-json';

/**
 * Context for {@link CreateNodesFunction}
 *
 * ** Experimental: ** these APIs may experience breaking changes outside of major versions.
 */
export interface CreateNodesContext {
  readonly nxJsonConfiguration: NxJsonConfiguration;
  readonly workspaceRoot: string;
}

/**
 * A function which parses a configuration file into a set of nodes.
 * Used for creating nodes for the {@link ProjectGraph}
 *
 * ** Experimental: ** these APIs may experience breaking changes outside of major versions.
 */
export type CreateNodesFunction = (
  projectConfigurationFile: string,
  context: CreateNodesContext
) => {
  projects?: Record<string, ProjectConfiguration>;
  externalNodes?: Record<string, ProjectGraphExternalNode>;
};

/**
 * A pair of file patterns and {@link CreateNodesFunction}
 *
 * ** Experimental: ** these APIs may experience breaking changes outside of major versions.
 */
export type CreateNodes = readonly [
  projectFilePattern: string,
  createNodesFunction: CreateNodesFunction
];

/**
 * Context for {@link CreateDependencies}
 *
 * ** Experimental: ** these APIs may experience breaking changes outside of major versions.
 */
export interface CreateDependenciesContext {
  /**
   * The current project graph,
   */
  readonly graph: ProjectGraph;

  /**
   * The configuration of each project in the workspace
   */
  readonly projectsConfigurations: ProjectsConfigurations;

  /**
   * The `nx.json` configuration from the workspace
   */
  readonly nxJsonConfiguration: NxJsonConfiguration;

  /**
   * All files in the workspace
   */
  readonly fileMap: ProjectFileMap;

  /**
   * Files changes since last invocation
   */
  readonly filesToProcess: ProjectFileMap;
}

/**
 * A function which parses files in the workspace to create dependencies in the {@link ProjectGraph}
 * Use {@link validateDependency} to validate dependencies
 *
 * ** Experimental: ** these APIs may experience breaking changes outside of major versions.
 */
export type CreateDependencies = (
  context: CreateDependenciesContext
) =>
  | ProjectGraphDependencyWithFile[]
  | Promise<ProjectGraphDependencyWithFile[]>;

/**
 * A plugin for Nx which creates nodes and dependencies for the {@link ProjectGraph}
 */
export type NxPluginV2 = {
  name: string;

  /**
   * Provides a file pattern and function that retrieves configuration info from
   * those files. e.g. { '**\/*.csproj': buildProjectsFromCsProjFile }
   */
  createNodes?: CreateNodes;

  // Todo(@AgentEnder): This shouldn't be a full processor, since its only responsible for defining edges between projects. What do we want the API to be?
  /**
   * Provides a function to analyze files to create dependencies for the {@link ProjectGraph}
   */
  createDependencies?: CreateDependencies;
};

export * from './nx-plugin.deprecated';

/**
 * A plugin for Nx
 */
export type NxPlugin = NxPluginV1 | NxPluginV2;

// Short lived cache (cleared between cmd runs)
// holding resolved nx plugin objects.
// Allows loadNxPlugins to be called multiple times w/o
// executing resolution mulitple times.
let nxPluginCache: Map<string, NxPlugin> = new Map();

function getPluginPathAndName(
  moduleName: string,
  paths: string[],
  root: string
) {
  let pluginPath: string;
  try {
    pluginPath = require.resolve(moduleName, {
      paths,
    });
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      const plugin = resolveLocalNxPlugin(moduleName, root);
      if (plugin) {
        const main = readPluginMainFromProjectConfiguration(
          plugin.projectConfig
        );
        pluginPath = main ? path.join(root, main) : plugin.path;
      } else {
        logger.error(`Plugin listed in \`nx.json\` not found: ${moduleName}`);
        throw e;
      }
    } else {
      throw e;
    }
  }
  const packageJsonPath = path.join(pluginPath, 'package.json');

  const { name } =
    !['.ts', '.js'].some((x) => x === path.extname(pluginPath)) && // Not trying to point to a ts or js file
    existsSync(packageJsonPath) // plugin has a package.json
      ? readJsonFile(packageJsonPath) // read name from package.json
      : { name: moduleName };
  return { pluginPath, name };
}

export async function loadNxPluginAsync(
  moduleName: string,
  paths: string[],
  root: string
) {
  let pluginModule = nxPluginCache.get(moduleName);
  if (pluginModule) {
    return pluginModule;
  }

  let { pluginPath, name } = getPluginPathAndName(moduleName, paths, root);
  const plugin = (await import(pluginPath)) as NxPlugin;
  plugin.name ??= name;
  nxPluginCache.set(moduleName, plugin);
  return plugin;
}

function loadNxPluginSync(moduleName: string, paths: string[], root: string) {
  let pluginModule = nxPluginCache.get(moduleName);
  if (pluginModule) {
    return pluginModule;
  }

  let { pluginPath, name } = getPluginPathAndName(moduleName, paths, root);
  const plugin = require(pluginPath) as NxPlugin;
  plugin.name ??= name;
  nxPluginCache.set(moduleName, plugin);
  return plugin;
}

/**
 * @deprecated Use loadNxPlugins instead.
 */
export function loadNxPluginsSync(
  plugins: string[],
  paths = getNxRequirePaths(),
  root = workspaceRoot
): (NxPluginV2 & Pick<NxPluginV1, 'processProjectGraph'>)[] {
  // TODO: This should be specified in nx.json
  // Temporarily load js as if it were a plugin which is built into nx
  // In the future, this will be optional and need to be specified in nx.json
  const result: NxPlugin[] = [...getDefaultPluginsSync(root)];

  if (shouldMergeAngularProjects(root, false)) {
    result.push(NxAngularJsonPlugin);
  }

  plugins ??= [];
  for (const plugin of plugins) {
    try {
      result.push(loadNxPluginSync(plugin, paths, root));
    } catch (e) {
      if (e.code === 'ERR_REQUIRE_ESM') {
        throw new Error(
          `Unable to load "${plugin}". Plugins cannot be ESM modules. They must be CommonJS modules. Follow the issue on github: https://github.com/nrwl/nx/issues/15682`
        );
      }
      throw e;
    }
  }

  // We push the nx core node plugins onto the end, s.t. it overwrites any other plugins
  result.push(
    getNxPackageJsonWorkspacesPlugin(root),
    CreateProjectJsonProjectsPlugin
  );

  return result.map(ensurePluginIsV2);
}

export async function loadNxPlugins(
  plugins: string[],
  paths = getNxRequirePaths(),
  root = workspaceRoot
): Promise<(NxPluginV2 & Pick<NxPluginV1, 'processProjectGraph'>)[]> {
  const result: NxPlugin[] = [...(await getDefaultPlugins(root))];

  // TODO: These should be specified in nx.json
  // Temporarily load js as if it were a plugin which is built into nx
  // In the future, this will be optional and need to be specified in nx.json
  result.push();

  plugins ??= [];
  for (const plugin of plugins) {
    result.push(await loadNxPluginAsync(plugin, paths, root));
  }

  // We push the nx core node plugins onto the end, s.t. it overwrites any other plugins
  result.push(
    getNxPackageJsonWorkspacesPlugin(root),
    CreateProjectJsonProjectsPlugin
  );

  return result.map(ensurePluginIsV2);
}

function ensurePluginIsV2(plugin: NxPlugin): NxPluginV2 {
  if (isNxPluginV2(plugin)) {
    return plugin;
  }
  if (isNxPluginV1(plugin) && plugin.projectFilePatterns) {
    return {
      ...plugin,
      createNodes: [
        `*/**/${combineGlobPatterns(plugin.projectFilePatterns)}`,
        (configFilePath) => {
          const name = toProjectName(configFilePath);
          return {
            projects: {
              [name]: {
                name,
                root: dirname(configFilePath),
                targets: plugin.registerProjectTargets?.(configFilePath),
              },
            },
          };
        },
      ],
    };
  }
  return plugin;
}

export function isNxPluginV2(plugin: NxPlugin): plugin is NxPluginV2 {
  return 'createNodes' in plugin || 'createDependencies' in plugin;
}

export function isNxPluginV1(plugin: NxPlugin): plugin is NxPluginV1 {
  return 'processProjectGraph' in plugin || 'projectFilePatterns' in plugin;
}

export function readPluginPackageJson(
  pluginName: string,
  paths = getNxRequirePaths()
): {
  path: string;
  json: PackageJson;
} {
  try {
    const result = readModulePackageJsonWithoutFallbacks(pluginName, paths);
    return {
      json: result.packageJson,
      path: result.path,
    };
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      const localPluginPath = resolveLocalNxPlugin(pluginName);
      if (localPluginPath) {
        const localPluginPackageJson = path.join(
          localPluginPath.path,
          'package.json'
        );
        return {
          path: localPluginPackageJson,
          json: readJsonFile(localPluginPackageJson),
        };
      }
    }
    throw e;
  }
}

/**
 * Builds a plugin package and returns the path to output
 * @param importPath What is the import path that refers to a potential plugin?
 * @returns The path to the built plugin, or null if it doesn't exist
 */
const localPluginCache: Record<
  string,
  { path: string; projectConfig: ProjectConfiguration }
> = {};
export function resolveLocalNxPlugin(
  importPath: string,
  root = workspaceRoot
): { path: string; projectConfig: ProjectConfiguration } | null {
  localPluginCache[importPath] ??= lookupLocalPlugin(importPath, root);
  return localPluginCache[importPath];
}

let tsNodeAndPathsRegistered = false;

/**
 * Register swc-node or ts-node if they are not currently registered
 * with some default settings which work well for Nx plugins.
 */
export function registerPluginTSTranspiler() {
  if (!tsNodeAndPathsRegistered) {
    // nx-ignore-next-line
    const ts: typeof import('typescript') = require('typescript');

    // Get the first tsconfig that matches the allowed set
    const tsConfigName = [
      join(workspaceRoot, 'tsconfig.base.json'),
      join(workspaceRoot, 'tsconfig.json'),
    ].find((x) => existsSync(x));

    const tsConfig: Partial<ts.ParsedCommandLine> = tsConfigName
      ? readTsConfig(tsConfigName)
      : {};

    registerTsConfigPaths(tsConfigName);
    registerTranspiler({
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      ...tsConfig.options,
      lib: ['es2021'],
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2021,
      inlineSourceMap: true,
      skipLibCheck: true,
    });
  }
  tsNodeAndPathsRegistered = true;
}

function lookupLocalPlugin(importPath: string, root = workspaceRoot) {
  const projects = retrieveProjectConfigurationsWithoutPluginInference(root);
  const plugin = findNxProjectForImportPath(importPath, projects, root);
  if (!plugin) {
    return null;
  }

  if (!tsNodeAndPathsRegistered) {
    registerPluginTSTranspiler();
  }

  const projectConfig: ProjectConfiguration = projects[plugin];
  return { path: path.join(root, projectConfig.root), projectConfig };
}

function findNxProjectForImportPath(
  importPath: string,
  projects: Record<string, ProjectConfiguration>,
  root = workspaceRoot
): string | null {
  const tsConfigPaths: Record<string, string[]> = readTsConfigPaths(root);
  const possiblePaths = tsConfigPaths[importPath]?.map((p) =>
    normalizePath(path.relative(root, path.join(root, p)))
  );
  if (possiblePaths?.length) {
    const projectRootMappings =
      createProjectRootMappingsFromProjectConfigurations(projects);
    for (const tsConfigPath of possiblePaths) {
      const nxProject = findProjectForPath(tsConfigPath, projectRootMappings);
      if (nxProject) {
        return nxProject;
      }
    }
    if (process.env.NX_VERBOSE_LOGGING) {
      console.log(
        'Unable to find local plugin',
        possiblePaths,
        projectRootMappings
      );
    }
    throw new Error(
      'Unable to resolve local plugin with import path ' + importPath
    );
  }
}

let tsconfigPaths: Record<string, string[]>;
function readTsConfigPaths(root: string = workspaceRoot) {
  if (!tsconfigPaths) {
    const tsconfigPath: string | null = ['tsconfig.base.json', 'tsconfig.json']
      .map((x) => path.join(root, x))
      .filter((x) => existsSync(x))[0];
    if (!tsconfigPath) {
      throw new Error('unable to find tsconfig.base.json or tsconfig.json');
    }
    const { compilerOptions } = readJsonFile(tsconfigPath);
    tsconfigPaths = compilerOptions?.paths;
  }
  return tsconfigPaths ?? {};
}

function readPluginMainFromProjectConfiguration(
  plugin: ProjectConfiguration
): string | null {
  const { main } =
    Object.values(plugin.targets).find((x) =>
      [
        '@nx/js:tsc',
        '@nrwl/js:tsc',
        '@nx/js:swc',
        '@nrwl/js:swc',
        '@nx/node:package',
        '@nrwl/node:package',
      ].includes(x.executor)
    )?.options ||
    plugin.targets?.build?.options ||
    {};
  return main;
}

async function getDefaultPlugins(root: string) {
  const plugins: NxPlugin[] = [await import('../plugins/js')];

  if (shouldMergeAngularProjects(root, false)) {
    plugins.push(
      await import('../adapter/angular-json').then((m) => m.NxAngularJsonPlugin)
    );
  }
  return plugins;
}

function getDefaultPluginsSync(root: string) {
  const plugins: NxPlugin[] = [require('../plugins/js')];

  if (shouldMergeAngularProjects(root, false)) {
    plugins.push(require('../adapter/angular-json').NxAngularJsonPlugin);
  }
  return plugins;
}
