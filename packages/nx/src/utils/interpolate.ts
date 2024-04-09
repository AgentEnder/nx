import { ProjectConfiguration } from '../config/workspace-json-project-json';

export function interpolateWithNxTokens(
  template: string,
  project: ProjectConfiguration,
  extraTokens: Record<string, unknown> = {}
): string {
  return interpolate(template, {
    ...extraTokens,
    projectRoot: project.root,
    projectName: project.name,
    workspaceRoot: '',
  });
}

export function interpolate(template: string, data: any): string {
  if (template.includes('{workspaceRoot}', 1)) {
    throw new Error(
      `Output '${template}' is invalid. {workspaceRoot} can only be used at the beginning of the expression.`
    );
  }

  if (data.projectRoot == '.' && template.includes('{projectRoot}', 1)) {
    throw new Error(
      `Output '${template}' is invalid. When {projectRoot} is '.', it can only be used at the beginning of the expression.`
    );
  }

  let res = template.replace('{workspaceRoot}/', '');

  if (data.projectRoot == '.') {
    res = res.replace('{projectRoot}/', '');
  }

  return res.replace(/{([\s\S]+?)}/g, (match: string) => {
    let value = data;
    let path = match.slice(1, -1).trim().split('.');
    for (let idx = 0; idx < path.length; idx++) {
      if (!value[path[idx]]) {
        return match;
      }
      value = value[path[idx]];
    }
    return value;
  });
}
