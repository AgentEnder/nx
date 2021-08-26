import { PackageManager } from './package-manager';
import { TargetDependencyConfig } from './workspace';

export type ImplicitDependencyEntry<T = '*' | string[]> = {
  [key: string]: T | ImplicitJsonSubsetDependency<T>;
};

export interface ImplicitJsonSubsetDependency<T = '*' | string[]> {
  [key: string]: T | ImplicitJsonSubsetDependency<T>;
}

export interface NxAffectedConfig {
  /**
   * Default based branch used by affected commands.
   */
  defaultBase?: string;
}

/**
 * Nx.json configuration
 */
export interface NxJsonConfiguration<T = '*' | string[]> {
  /**
   * Map of files to projects that implicitly depend on them
   */
  implicitDependencies?: ImplicitDependencyEntry<T>;
  /**
   * Dependencies between different target names across all projects
   */
  targetDependencies?: Record<string, TargetDependencyConfig[]>;
  /**
   * NPM Scope that the workspace uses
   */
  npmScope: string;
  /**
   * Default options for `nx affected`
   */
  affected?: NxAffectedConfig;
  /**
   * Where new apps + libs should be placed
   */
  workspaceLayout?: {
    libsDir: string;
    appsDir: string;
  };
  /**
   * Available Task Runners
   */
  tasksRunnerOptions?: {
    [tasksRunnerName: string]: {
      /**
       * Path to resolve the runner
       */
      runner: string;
      /**
       * Default options for the runner
       */
      options?: any;
    };
  };
  /**
   * List of default values used by generators.
   *
   * These defaults are global. They are used when no other defaults are configured.
   *
   * Example:
   *
   * ```
   * {
   *   "@nrwl/react": {
   *     "library": {
   *       "style": "scss"
   *     }
   *   }
   * }
   * ```
   */
  generators?: { [collectionName: string]: { [generatorName: string]: any } };

  /**
   * Default generator collection. It is used when no collection is provided.
   */
  cli?: {
    packageManager?: PackageManager;
    defaultCollection?: string;
  };
  /**
   * Plugins for extending the project graph
   */
  plugins?: string[];
}

/**
 * @deprecated(2021-08-26): NxJson no longer contains projects
 */
export interface NxJsonProjectConfiguration {
  implicitDependencies?: string[];
  tags?: string[];
}
