import {
  DependencyType,
  NxPluginV2,
  ProjectGraphDependencyWithFile,
  readJsonFile,
} from '@nx/devkit';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PackageJson } from 'nx/src/utils/package-json';

export const plugin: NxPluginV2 = {
  name: 'nx-plugin-executor-dependencies',
  createDependencies: (context) => {
    const deps: ProjectGraphDependencyWithFile[] = [];
    const projects = context.projectsConfigurations.projects;
    // pkgName -> projectName
    const localPlugins = new Map<string, string>();
    for (const project in projects) {
      const maybePackageJson = join(projects[project].root, 'package.json');
      try {
        const { name } = readJsonFile<PackageJson>(maybePackageJson);
        localPlugins.set(name, project);
      } catch {
        // package.json doesn't exist or is malformed
      }
    }
    for (const project in projects) {
      const targets = projects[project].targets ?? {};
      const root = projects[project].root;

      for (const target in targets) {
        const executor = targets[target].executor;
        const [pkg] = executor.split(':');
        if (localPlugins.has(pkg)) {
          const maybeProjectJson = join(root, 'project.json');
          if (existsSync(maybeProjectJson)) {
            deps.push({
              dependencyType: DependencyType.static,
              source: project,
              target: localPlugins.get(pkg),
              sourceFile: maybeProjectJson,
            });
          } else {
            // Coming from some form of inference, no source file.
            deps.push({
              dependencyType: DependencyType.implicit,
              source: project,
              target: localPlugins.get(pkg),
            });
          }
        }
      }
    }
    console.log({ deps });
    return deps;
  },
};
