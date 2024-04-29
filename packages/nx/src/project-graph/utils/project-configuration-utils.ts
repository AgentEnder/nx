import { NxJsonConfiguration, TargetDefaults } from '../../config/nx-json';
import { ProjectGraphExternalNode } from '../../config/project-graph';
import {
  ProjectConfiguration,
  ProjectMetadata,
  TargetConfiguration,
  TargetMetadata,
} from '../../config/workspace-json-project-json';
import { NX_PREFIX } from '../../utils/logger';
import { readJsonFile } from '../../utils/fileutils';
import { workspaceRoot } from '../../utils/workspace-root';
import {
  ONLY_MODIFIES_EXISTING_TARGET,
  OVERRIDE_SOURCE_FILE,
} from '../../plugins/target-defaults/symbols';

import { minimatch } from 'minimatch';
import { join } from 'path';
import { performance } from 'perf_hooks';
import {
  CreateNodesResultWithContext,
  LoadedNxPlugin,
} from '../plugins/internal-api';
import {
  CreateNodesError,
  MergeNodesError,
  ProjectConfigurationsError,
  isAggregateCreateNodesError,
  ProjectsWithNoNameError,
  ProjectsWithConflictingNamesError,
  isProjectsWithConflictingNamesError,
  isProjectsWithNoNameError,
} from '../error-types';

export type SourceInformation = [file: string | null, plugin: string];
export type ConfigurationSourceMaps = Record<
  string,
  Record<string, SourceInformation>
>;

export function mergeProjectConfigurationIntoRootMap(
  projectRootMap: Record<string, ProjectConfiguration>,
  project: ProjectConfiguration & {
    targets?: Record<
      string,
      TargetConfiguration & { [ONLY_MODIFIES_EXISTING_TARGET]?: boolean }
    >;
  },
  configurationSourceMaps?: ConfigurationSourceMaps,
  sourceInformation?: SourceInformation,
  // This function is used when reading project configuration
  // in generators, where we don't want to do this.
  skipTargetNormalization?: boolean
): void {
  if (configurationSourceMaps && !configurationSourceMaps[project.root]) {
    configurationSourceMaps[project.root] = {};
  }
  const sourceMap = configurationSourceMaps?.[project.root];

  let matchingProject = projectRootMap[project.root];

  if (!matchingProject) {
    projectRootMap[project.root] = {
      root: project.root,
    };
    matchingProject = projectRootMap[project.root];
    if (sourceMap) {
      sourceMap[`root`] = sourceInformation;
    }
  }

  // This handles top level properties that are overwritten.
  // e.g. `srcRoot`, `projectType`, or other fields that shouldn't be extended
  // Note: `name` is set specifically here to keep it from changing. The name is
  // always determined by the first inference plugin to ID a project, unless it has
  // a project.json in which case it was already updated above.
  const updatedProjectConfiguration = {
    ...matchingProject,
  };

  for (const k in project) {
    if (
      ![
        'tags',
        'implicitDependencies',
        'generators',
        'targets',
        'metadata',
        'namedInputs',
      ].includes(k)
    ) {
      updatedProjectConfiguration[k] = project[k];
      if (sourceMap) {
        sourceMap[`${k}`] = sourceInformation;
      }
    }
  }

  // The next blocks handle properties that should be themselves merged (e.g. targets, tags, and implicit dependencies)
  if (project.tags) {
    updatedProjectConfiguration.tags = Array.from(
      new Set((matchingProject.tags ?? []).concat(project.tags))
    );

    if (sourceMap) {
      sourceMap['tags'] ??= sourceInformation;
      project.tags.forEach((tag) => {
        sourceMap[`tags.${tag}`] = sourceInformation;
      });
    }
  }

  if (project.implicitDependencies) {
    updatedProjectConfiguration.implicitDependencies = (
      matchingProject.implicitDependencies ?? []
    ).concat(project.implicitDependencies);

    if (sourceMap) {
      sourceMap['implicitDependencies'] ??= sourceInformation;
      project.implicitDependencies.forEach((implicitDependency) => {
        sourceMap[`implicitDependencies.${implicitDependency}`] =
          sourceInformation;
      });
    }
  }

  if (project.generators) {
    // Start with generators config in new project.
    updatedProjectConfiguration.generators = { ...project.generators };

    if (sourceMap) {
      sourceMap['generators'] ??= sourceInformation;
      for (const generator in project.generators) {
        sourceMap[`generators.${generator}`] = sourceInformation;
        for (const property in project.generators[generator]) {
          sourceMap[`generators.${generator}.${property}`] = sourceInformation;
        }
      }
    }

    if (matchingProject.generators) {
      // For each generator that was already defined, shallow merge the options.
      // Project contains the new info, so it has higher priority.
      for (const generator in matchingProject.generators) {
        updatedProjectConfiguration.generators[generator] = {
          ...matchingProject.generators[generator],
          ...project.generators[generator],
        };
      }
    }
  }

  if (project.namedInputs) {
    updatedProjectConfiguration.namedInputs = {
      ...matchingProject.namedInputs,
      ...project.namedInputs,
    };

    if (sourceMap) {
      sourceMap['namedInputs'] ??= sourceInformation;
      for (const namedInput in project.namedInputs) {
        sourceMap[`namedInputs.${namedInput}`] = sourceInformation;
      }
    }
  }

  if (project.metadata) {
    updatedProjectConfiguration.metadata = mergeMetadata(
      sourceMap,
      sourceInformation,
      'metadata',
      project.metadata,
      matchingProject.metadata
    );
  }

  if (project.targets) {
    // We merge the targets with special handling, so clear this back to the
    // targets as defined originally before merging.
    updatedProjectConfiguration.targets = matchingProject?.targets ?? {};
    if (sourceMap) {
      sourceMap['targets'] ??= sourceInformation;
    }

    // For each target defined in the new config
    for (const targetName in project.targets) {
      // Always set source map info for the target, but don't overwrite info already there
      // if augmenting an existing target.

      const target = project.targets?.[targetName];

      if (sourceMap && !target?.[ONLY_MODIFIES_EXISTING_TARGET]) {
        sourceMap[`targets.${targetName}`] = sourceInformation;
      }

      // If ONLY_MODIFIES_EXISTING_TARGET is true, and its not on the matching project
      // we shouldn't merge its info into the graph
      if (
        target?.[ONLY_MODIFIES_EXISTING_TARGET] &&
        !matchingProject.targets?.[targetName]
      ) {
        continue;
      }

      const normalizedTarget = skipTargetNormalization
        ? target
        : normalizeTarget(target, project);

      const mergedTarget = mergeTargetConfigurations(
        normalizedTarget,
        matchingProject.targets?.[targetName],
        sourceMap,
        sourceInformation,
        `targets.${targetName}`
      );

      // We don't want the symbol to live on past the merge process
      if (mergedTarget?.[ONLY_MODIFIES_EXISTING_TARGET])
        delete mergedTarget?.[ONLY_MODIFIES_EXISTING_TARGET];

      updatedProjectConfiguration.targets[targetName] = mergedTarget;
    }
  }

  projectRootMap[updatedProjectConfiguration.root] =
    updatedProjectConfiguration;
}

export function mergeMetadata<T = ProjectMetadata | TargetMetadata>(
  sourceMap: Record<string, [file: string, plugin: string]>,
  sourceInformation: [file: string, plugin: string],
  baseSourceMapPath: string,
  metadata: T,
  matchingMetadata?: T
): T {
  const result: T = {
    ...(matchingMetadata ?? ({} as T)),
  };
  for (const [metadataKey, value] of Object.entries(metadata)) {
    const existingValue = matchingMetadata?.[metadataKey];

    if (Array.isArray(value) && Array.isArray(existingValue)) {
      for (const item of [...value]) {
        const newLength = result[metadataKey].push(item);
        if (sourceMap) {
          sourceMap[`${baseSourceMapPath}.${metadataKey}.${newLength - 1}`] =
            sourceInformation;
        }
      }
    } else if (Array.isArray(value) && existingValue === undefined) {
      result[metadataKey] ??= value;
      if (sourceMap) {
        sourceMap[`${baseSourceMapPath}.${metadataKey}`] = sourceInformation;
      }
      for (let i = 0; i < value.length; i++) {
        if (sourceMap) {
          sourceMap[`${baseSourceMapPath}.${metadataKey}.${i}`] =
            sourceInformation;
        }
      }
    } else if (typeof value === 'object' && typeof existingValue === 'object') {
      for (const key in value) {
        const existingValue = matchingMetadata?.[metadataKey]?.[key];

        if (Array.isArray(value[key]) && Array.isArray(existingValue)) {
          for (const item of value[key]) {
            const i = result[metadataKey][key].push(item);
            if (sourceMap) {
              sourceMap[`${baseSourceMapPath}.${metadataKey}.${key}.${i - 1}`] =
                sourceInformation;
            }
          }
        } else {
          result[metadataKey] = value;
          if (sourceMap) {
            sourceMap[`${baseSourceMapPath}.${metadataKey}`] =
              sourceInformation;
          }
        }
      }
    } else {
      result[metadataKey] = value;
      if (sourceMap) {
        sourceMap[`${baseSourceMapPath}.${metadataKey}`] = sourceInformation;

        if (typeof value === 'object') {
          for (const k in value) {
            sourceMap[`${baseSourceMapPath}.${metadataKey}.${k}`] =
              sourceInformation;
            if (Array.isArray(value[k])) {
              for (let i = 0; i < value[k].length; i++) {
                sourceMap[`${baseSourceMapPath}.${metadataKey}.${k}.${i}`] =
                  sourceInformation;
              }
            }
          }
        }
      }
    }
  }
  return result;
}

export type ConfigurationResult = {
  /**
   * A map of project configurations, keyed by project root.
   */
  projects: {
    [projectRoot: string]: ProjectConfiguration;
  };

  /**
   * Node Name -> Node info
   */
  externalNodes: Record<string, ProjectGraphExternalNode>;

  /**
   * Project Root -> Project Name
   */
  projectRootMap: Record<string, string>;

  sourceMaps: ConfigurationSourceMaps;

  /**
   * The list of files that were used to create project configurations
   */
  matchingProjectFiles: string[];
};

/**
 * Transforms a list of project paths into a map of project configurations.
 *
 * @param root The workspace root
 * @param nxJson The NxJson configuration
 * @param workspaceFiles A list of non-ignored workspace files
 * @param plugins The plugins that should be used to infer project configuration
 */
export async function createProjectConfigurations(
  root: string = workspaceRoot,
  nxJson: NxJsonConfiguration,
  projectFiles: string[], // making this parameter allows devkit to pick up newly created projects
  plugins: LoadedNxPlugin[]
): Promise<ConfigurationResult> {
  performance.mark('build-project-configs:start');

  const results: Array<Promise<Array<CreateNodesResultWithContext>>> = [];
  const errors: Array<
    | CreateNodesError
    | MergeNodesError
    | ProjectsWithNoNameError
    | ProjectsWithConflictingNamesError
  > = [];

  // We iterate over plugins first - this ensures that plugins specified first take precedence.
  for (const {
    name: pluginName,
    createNodes: createNodesTuple,
    include,
    exclude,
  } of plugins) {
    const [pattern, createNodes] = createNodesTuple ?? [];

    if (!pattern) {
      continue;
    }

    const matchingConfigFiles: string[] = [];

    for (const file of projectFiles) {
      if (minimatch(file, pattern, { dot: true })) {
        if (include) {
          const included = include.some((includedPattern) =>
            minimatch(file, includedPattern, { dot: true })
          );
          if (!included) {
            continue;
          }
        }

        if (exclude) {
          const excluded = exclude.some((excludedPattern) =>
            minimatch(file, excludedPattern, { dot: true })
          );
          if (excluded) {
            continue;
          }
        }

        matchingConfigFiles.push(file);
      }
    }
    let r = createNodes(matchingConfigFiles, {
      nxJsonConfiguration: nxJson,
      workspaceRoot: root,
      configFiles: matchingConfigFiles,
    }).catch((e) => {
      if (isAggregateCreateNodesError(e)) {
        errors.push(...e.errors);
        return e.partialResults;
      } else {
        throw e;
      }
    });

    results.push(r);
  }

  return Promise.all(results).then((results) => {
    performance.mark('createNodes:merge - start');
    const projectRootMap: Record<string, ProjectConfiguration> = {};
    const externalNodes: Record<string, ProjectGraphExternalNode> = {};
    const configurationSourceMaps: Record<
      string,
      Record<string, SourceInformation>
    > = {};

    for (const result of results.flat()) {
      const {
        projects: projectNodes,
        externalNodes: pluginExternalNodes,
        file,
        pluginName,
      } = result;

      const sourceInfo: SourceInformation = [file, pluginName];

      if (result[OVERRIDE_SOURCE_FILE]) {
        sourceInfo[0] = result[OVERRIDE_SOURCE_FILE];
      }

      for (const node in projectNodes) {
        const project = {
          root: node,
          ...projectNodes[node],
        };
        try {
          mergeProjectConfigurationIntoRootMap(
            projectRootMap,
            project,
            configurationSourceMaps,
            sourceInfo
          );
        } catch (error) {
          errors.push(
            new MergeNodesError({
              file,
              pluginName,
              error,
            })
          );
        }
      }
      Object.assign(externalNodes, pluginExternalNodes);
    }

    try {
      // We still call this just to assert that the root map
      // only contains valid project names. This is a safety check.
      //
      // The signature itself can't be changed as we need it to return
      // project configurations for use in devkit.
      readProjectConfigurationsFromRootMap(projectRootMap);
    } catch (e) {
      if (
        isProjectsWithNoNameError(e) ||
        isProjectsWithConflictingNamesError(e)
      ) {
        errors.push(e);
      } else {
        throw e;
      }
    }

    const rootMap = createRootMap(projectRootMap);

    performance.mark('createNodes:merge - end');
    performance.measure(
      'createNodes:merge',
      'createNodes:merge - start',
      'createNodes:merge - end'
    );

    performance.mark('build-project-configs:end');
    performance.measure(
      'build-project-configs',
      'build-project-configs:start',
      'build-project-configs:end'
    );

    if (errors.length === 0) {
      return {
        projects: projectRootMap,
        externalNodes,
        projectRootMap: rootMap,
        sourceMaps: configurationSourceMaps,
        matchingProjectFiles: projectFiles,
      };
    } else {
      throw new ProjectConfigurationsError(errors, {
        projects: projectRootMap,
        externalNodes,
        projectRootMap: rootMap,
        sourceMaps: configurationSourceMaps,
        matchingProjectFiles: projectFiles,
      });
    }
  });
}

export function readProjectConfigurationsFromRootMap(
  projectRootMap: Record<string, ProjectConfiguration>
) {
  const projects: Record<string, ProjectConfiguration> = {};
  // If there are projects that have the same name, that is an error.
  // This object tracks name -> (all roots of projects with that name)
  // to provide better error messaging.
  const conflicts = new Map<string, string[]>();
  const projectRootsWithNoName: string[] = [];

  for (const root in projectRootMap) {
    const configuration = projectRootMap[root];
    // We're setting `// targets` as a comment `targets` is empty due to Project Crystal.
    // Strip it before returning configuration for usage.
    if (configuration['// targets']) delete configuration['// targets'];
    if (!configuration.name) {
      try {
        const { name } = readJsonFile(join(root, 'package.json'));
        configuration.name = name;
      } catch {
        projectRootsWithNoName.push(root);
      }
    }
    if (configuration.name in projects) {
      let rootErrors = conflicts.get(configuration.name) ?? [
        projects[configuration.name].root,
      ];
      rootErrors.push(root);
      conflicts.set(configuration.name, rootErrors);
      projects[configuration.name] = configuration;
    } else {
      projects[configuration.name] = configuration;
    }
  }

  if (conflicts.size > 0) {
    throw new ProjectsWithConflictingNamesError(conflicts, projects);
  }
  if (projectRootsWithNoName.length > 0) {
    throw new ProjectsWithNoNameError(projectRootsWithNoName, projects);
  }
  return projects;
}

/**
 * Merges two targets.
 *
 * Most properties from `target` will overwrite any properties from `baseTarget`.
 * Options and configurations are treated differently - they are merged together if the executor definition is compatible.
 *
 * @param target The target definition with higher priority
 * @param baseTarget The target definition that should be overwritten. Can be undefined, in which case the target is returned as-is.
 * @param projectConfigSourceMap The source map to be filled with metadata about where each property came from
 * @param sourceInformation The metadata about where the new target was defined
 * @param targetIdentifier The identifier for the target to merge, used for source map
 * @returns A merged target configuration
 */
export function mergeTargetConfigurations(
  target: TargetConfiguration,
  baseTarget?: TargetConfiguration,
  projectConfigSourceMap?: Record<string, SourceInformation>,
  sourceInformation?: SourceInformation,
  targetIdentifier?: string
): TargetConfiguration {
  const {
    configurations: defaultConfigurations,
    options: defaultOptions,
    ...baseTargetProperties
  } = baseTarget ?? {};

  // Target is "compatible", e.g. executor is defined only once or is the same
  // in both places. This means that it is likely safe to merge
  const isCompatible = isCompatibleTarget(baseTarget ?? {}, target);

  // If the targets are not compatible, we would normally overwrite the old target
  // with the new one. However, we have a special case for targets that have the
  // ONLY_MODIFIES_EXISTING_TARGET symbol set. This prevents the merged target
  // equaling info that should have only been used to modify the existing target.
  if (!isCompatible && target[ONLY_MODIFIES_EXISTING_TARGET]) {
    return baseTarget;
  }

  if (!isCompatible && projectConfigSourceMap) {
    // if the target is not compatible, we will simply override the options
    // we have to delete old entries from the source map
    for (const key in projectConfigSourceMap) {
      if (key.startsWith(`${targetIdentifier}`)) {
        delete projectConfigSourceMap[key];
      }
    }
  }

  // merge top level properties if they're compatible
  const result = {
    ...(isCompatible ? baseTargetProperties : {}),
    ...target,
  };

  // record top level properties in source map
  if (projectConfigSourceMap) {
    projectConfigSourceMap[targetIdentifier] = sourceInformation;

    // record root level target properties to source map
    for (const targetProperty in target) {
      const targetPropertyId = `${targetIdentifier}.${targetProperty}`;
      projectConfigSourceMap[targetPropertyId] = sourceInformation;
    }
  }

  // merge options if there are any
  // if the targets aren't compatible, we simply discard the old options during the merge
  if (target.options || defaultOptions) {
    result.options = mergeOptions(
      target.options,
      isCompatible ? defaultOptions : undefined,
      projectConfigSourceMap,
      sourceInformation,
      targetIdentifier
    );
  }

  // merge configurations if there are any
  // if the targets aren't compatible, we simply discard the old configurations during the merge
  if (target.configurations || defaultConfigurations) {
    result.configurations = mergeConfigurations(
      target.configurations,
      isCompatible ? defaultConfigurations : undefined,
      projectConfigSourceMap,
      sourceInformation,
      targetIdentifier
    );
  }

  if (target.metadata) {
    result.metadata = mergeMetadata(
      projectConfigSourceMap,
      sourceInformation,
      `${targetIdentifier}.metadata`,
      target.metadata,
      baseTarget?.metadata
    );
  }

  return result as TargetConfiguration;
}

/**
 * Checks if targets options are compatible - used when merging configurations
 * to avoid merging options for @nx/js:tsc into something like @nx/webpack:webpack.
 *
 * If the executors are both specified and don't match, the options aren't considered
 * "compatible" and shouldn't be merged.
 */
export function isCompatibleTarget(
  a: TargetConfiguration,
  b: TargetConfiguration
) {
  const oneHasNoExecutor = !a.executor || !b.executor;
  const bothHaveSameExecutor = a.executor === b.executor;

  if (oneHasNoExecutor) return true;
  if (!bothHaveSameExecutor) return false;

  const isRunCommands = a.executor === 'nx:run-commands';
  if (isRunCommands) {
    const aCommand = a.options?.command ?? a.options?.commands?.join(' && ');
    const bCommand = b.options?.command ?? b.options?.commands?.join(' && ');

    const oneHasNoCommand = !aCommand || !bCommand;
    const hasSameCommand = aCommand === bCommand;

    return oneHasNoCommand || hasSameCommand;
  }

  const isRunScript = a.executor === 'nx:run-script';
  if (isRunScript) {
    const aScript = a.options?.script;
    const bScript = b.options?.script;

    const oneHasNoScript = !aScript || !bScript;
    const hasSameScript = aScript === bScript;

    return oneHasNoScript || hasSameScript;
  }

  return true;
}

function mergeConfigurations<T extends Object>(
  newConfigurations: Record<string, T> | undefined,
  baseConfigurations: Record<string, T> | undefined,
  projectConfigSourceMap?: Record<string, SourceInformation>,
  sourceInformation?: SourceInformation,
  targetIdentifier?: string
): Record<string, T> | undefined {
  const mergedConfigurations = {};

  const configurations = new Set([
    ...Object.keys(baseConfigurations ?? {}),
    ...Object.keys(newConfigurations ?? {}),
  ]);
  for (const configuration of configurations) {
    mergedConfigurations[configuration] = {
      ...(baseConfigurations?.[configuration] ?? {}),
      ...(newConfigurations?.[configuration] ?? {}),
    };
  }

  // record new configurations & configuration properties in source map
  if (projectConfigSourceMap) {
    for (const newConfiguration in newConfigurations) {
      projectConfigSourceMap[
        `${targetIdentifier}.configurations.${newConfiguration}`
      ] = sourceInformation;
      for (const configurationProperty in newConfigurations[newConfiguration]) {
        projectConfigSourceMap[
          `${targetIdentifier}.configurations.${newConfiguration}.${configurationProperty}`
        ] = sourceInformation;
      }
    }
  }

  return mergedConfigurations;
}

function mergeOptions(
  newOptions: Record<string, any> | undefined,
  baseOptions: Record<string, any> | undefined,
  projectConfigSourceMap?: Record<string, SourceInformation>,
  sourceInformation?: SourceInformation,
  targetIdentifier?: string
): Record<string, any> | undefined {
  const mergedOptions = {
    ...(baseOptions ?? {}),
    ...(newOptions ?? {}),
  };

  // record new options & option properties in source map
  if (projectConfigSourceMap) {
    for (const newOption in newOptions) {
      projectConfigSourceMap[`${targetIdentifier}.options.${newOption}`] =
        sourceInformation;
    }
  }

  return mergedOptions;
}

export function resolveNxTokensInOptions<T extends Object | Array<unknown>>(
  object: T,
  project: ProjectConfiguration,
  key: string
): T {
  const result: T = Array.isArray(object) ? ([...object] as T) : { ...object };
  for (let [opt, value] of Object.entries(object ?? {})) {
    if (typeof value === 'string') {
      const workspaceRootMatch = /^(\{workspaceRoot\}\/?)/.exec(value);
      if (workspaceRootMatch?.length) {
        value = value.replace(workspaceRootMatch[0], '');
      }
      if (value.includes('{workspaceRoot}')) {
        throw new Error(
          `${NX_PREFIX} The {workspaceRoot} token is only valid at the beginning of an option. (${key})`
        );
      }
      value = value.replace(/\{projectRoot\}/g, project.root);
      result[opt] = value.replace(/\{projectName\}/g, project.name);
    } else if (typeof value === 'object' && value) {
      result[opt] = resolveNxTokensInOptions(
        value,
        project,
        [key, opt].join('.')
      );
    }
  }
  return result;
}

export function readTargetDefaultsForTarget(
  targetName: string,
  targetDefaults: TargetDefaults,
  executor?: string
): TargetDefaults[string] {
  if (executor) {
    // If an executor is defined in project.json, defaults should be read
    // from the most specific key that matches that executor.
    // e.g. If executor === run-commands, and the target is named build:
    // Use, use nx:run-commands if it is present
    // If not, use build if it is present.
    const key = [executor, targetName].find((x) => targetDefaults?.[x]);
    return key ? targetDefaults?.[key] : null;
  } else {
    // If the executor is not defined, the only key we have is the target name.
    return targetDefaults?.[targetName];
  }
}

function createRootMap(projectRootMap: Record<string, ProjectConfiguration>) {
  const map: Record<string, string> = {};
  for (const projectRoot in projectRootMap) {
    const projectName = projectRootMap[projectRoot].name;
    map[projectRoot] = projectName;
  }
  return map;
}

function resolveCommandSyntacticSugar(
  target: TargetConfiguration,
  key: string
): TargetConfiguration {
  const { command, ...config } = target ?? {};

  if (!command) {
    return target;
  }

  if (config.executor) {
    throw new Error(
      `${NX_PREFIX} Project at ${key} should not have executor and command both configured.`
    );
  } else {
    return {
      ...config,
      executor: 'nx:run-commands',
      options: {
        ...config.options,
        command: command,
      },
    };
  }
}

export function normalizeTarget(
  target: TargetConfiguration,
  project: ProjectConfiguration
) {
  target = resolveCommandSyntacticSugar(target, project.root);

  target.options = resolveNxTokensInOptions(
    target.options,
    project,
    `${project.root}:${target}`
  );

  target.configurations ??= {};
  for (const configuration in target.configurations) {
    target.configurations[configuration] = resolveNxTokensInOptions(
      target.configurations[configuration],
      project,
      `${project.root}:${target}:${configuration}`
    );
  }

  return target;
}
