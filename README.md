# verdaccio-github-auth
![Release](https://github.com/outcome-co/verdaccio-github-auth/workflows/Release/badge.svg?branch=v1.1.1) 
![version-badge](https://img.shields.io/badge/version-1.2.1-brightgreen)

An authentication plugin for [Verdaccio](https://verdaccio.org) that uses a Github Organization as an authentication and authorization backend.

## Installation

```sh
npm install @outcome-co/verdaccio-github-auth
```

## Usage

TBD

## Development

### Auto-rebuild
To avoid having to manually rebuild the library after each change, you can automatically rebuild after you make changes.

In one terminal, run the following command to automatically rebuild the library when the source changes
```sh
npm run watch
```

In another terminal, run the following command to start the Verdaccio server, and have it automatically reload when the library is rebuilt
```sh
npm run server
```

### Configuration
The configuration file for the development server is stored in `./run/config/`. There is a template config file which you can use to start the configuration server. The configuration file should be called `config.yaml`, and should be placed in the `./run/config` directory.


Remember to run `./pre-commit.sh` when you clone the repository.

