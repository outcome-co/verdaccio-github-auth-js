# verdaccio-github-auth
![Release](https://github.com/outcome-co/verdaccio-github-auth-js/workflows/Release/badge.svg?branch=v2.0.1) ![version-badge](https://img.shields.io/badge/version-2.0.1-brightgreen)

An authentication plugin for [Verdaccio](https://verdaccio.org) that uses a Github Organization as an authentication and authorization backend.

## Installation

```sh
npm install @outcome-co/verdaccio-github-auth
```

## Usage

The plugin is configured with a Github Organization, and uses Repository memberships and permissions to determine the package access permissions.
The plugin makes a few assumptions:

-   Each repo corresponds to one package
-   The `name` field in the `package.json` corresponds to the name of the package in Verdaccio

### Permissions

In GitHub, repository permissions can come from multiple sources: the organization-level, directly on the repository, or via team membership. This auth plugin queries GitHub to retrieve the set of permissions and determines the highest level of privilege. GitHub permissions are quite diverse (`admin`, `maintain`, `triage`, etc.), but they map onto a simpler set of Verdaccio permissions (`read`/`write`).

To summarize the mapping, if you can push code to the repo, you can push packages to Verdaccio.

### Configuration

Add the following to your Verdaccio config:

```yaml
auth:
    '@outcome-co/verdaccio-github-auth':
        organization: '<ORG NAME>'
        token: '<ORG TOKEN>'
```

The token provided in the config file must have read access to all of the repositories.

| Option                | Description                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `repositoryPattern`   | A regexp used to filter the repositories seen by the plugin. Only matching repo names are kept. |
| `includeRepositories` | A list of repository names to use as a filter. Only names in the list are kept.                 |
| `excludeRepositories` | A list of repository names to to exclude. Only names not in the list are kept.                  |

## Development

Remember to run `./pre-commit.sh` when you clone the repository.

### Auto-rebuild

To avoid having to manually rebuild the library after each change, you can automatically rebuild after you make changes.

In one terminal, run the following command to automatically rebuild the library when the source changes

```sh
yarn run watch
```

In another terminal, run the following command to start the Verdaccio server, and have it automatically reload when the library is rebuilt

```sh
yarn run server
```

### Configuration

The configuration file for the development server is stored in `./run/config/`. There is a template config file which you can use to start the configuration server. The configuration file should be called `config.yaml`, and should be placed in the `./run/config` directory.

## Integration Tests

Integration tests interact directly with the Github API.
To set them up, please see [here](test/README.md)
