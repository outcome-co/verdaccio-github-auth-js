import GraphQLClient, { enumValue } from './graphql'
import Cache from './cache'
const { get, has, map, includes, reduce, forOwn, forEach, clone } = require('lodash')

export class ConfigurationError extends Error {}

export class APIError extends Error {}

export class AuthenticationError extends Error {
    constructor (message, loginState) {
        super(message)
        // Ensure the name of this error is the same as the class name
        this.name = this.constructor.name

        this.loginState = loginState

        // This clips the constructor invocation from the stack trace.
        // It's not absolutely essential, but it does make the stack trace a little nicer.
        //  @see Node.js reference (bottom)
        Error.captureStackTrace(this, this.constructor)
    }
}

/**
 * The union of two sets.
 *
 * @param {Set} a - The first set.
 * @param {Set} b - The second set.
 * @returns {Set} - The union.
 */
export const setUnion = function (a, b) {
    return new Set([...a, ...b])
}

const packageJson = 'package.json'

/**
 * @typedef {('READ'|'WRITE'|'ADMIN'|'NONE')} GithubGraphQLRepoPermissions
 * @typedef {('read'|'write')} PackagePermission
 */

const readPermission = 'read'
const writePermission = 'write'

/**
 * Maps Github GraphQL permissions to package permissions.
 *
 * The roles you provide when using the REST API (push/pull/triage, etc.)
 * are not the ones you find when you retrieve the permissions via GraphQL.
 *
 * @type {Object<GithubGraphQLRepoPermissions, Set<PackagePermission>>}
 * */
const permissionsMap = {
    ADMIN: new Set([readPermission, writePermission]),
    WRITE: new Set([readPermission, writePermission]),
    READ: new Set([readPermission]),
    NONE: new Set([])
}

/**
 * @typedef {object} RemoteUser
 * @property {Array<string>} real_groups
 * @property {Array<string>} groups - This contains the real groups, plus the virtual groups such as $authenticated
 * @property {string|null} name
 * @property {string?} error
 */

/**
 * This definition is for reference purposes. It's a Verdaccio type.
 * We don't actually use the publish/proxy/access info.
 *
 * @typedef {object} PackageAccess
 * @property {string} name - The name of the package, including the namespace.
 * @property {Array<string>?} publish
 * @property {Array<string>?} proxy
 * @property {Array<string>?} access
 */

/**
 * @callback VerdaccioAccessCallback
 * @param {*} err
 * @param {*} result
 */

/**
 * @typedef {Object<string, Array<string>>} Teams
 */

/**
 * Custom Verdaccio Authenticate Plugin.
 */
class GithubAuthPlugin {
    constructor (config, options) {
        if (typeof config === 'undefined') {
            throw new ConfigurationError('Missing configuration')
        }

        const { organization, token } = config

        if (!organization) {
            throw new ConfigurationError('Missing organization!')
        }

        if (!token) {
            throw new ConfigurationError('Missing token!')
        }

        this.organization = organization
        this.logger = options.logger

        this.includeRepositories = config.includeRepositories
        this.excludeRepositories = config.excludeRepositories
        this.repositoryPattern = config.repositoryPattern || /.*/

        this.client = new GraphQLClient(token, this.logger)
        this.cache = new Cache()

        return this
    }

    /* istanbul ignore next */
    get repositoryPattern () {
        return this._repositoryPattern
    }

    set repositoryPattern (pattern) {
        /* istanbul ignore else */
        if (!Object.prototype.isPrototypeOf.call(RegExp, pattern)) {
            pattern = RegExp(pattern)
        }

        this._repositoryPattern = pattern
    }

    /**
     * Maps a Github permission to a package permission.
     *
     * @param {GithubGraphQLRepoPermissions} githubPermission - The Github permission.
     * @returns {Set<PackagePermission>} - The package permission.
     */
    mapPermission (githubPermission) {
        const permission = permissionsMap[githubPermission]
        if (!permission) {
            throw new APIError(`Unknown permission type ${githubPermission}`)
        }
        return permission
    }

    /**
     * Authenticates the user for the given token.
     *
     * - Ensures that the token is valid and belongs to the user.
     * - Ensures that the user belongs to the organization.
     * - Retrieves the list of teams to which the user belongs.
     *
     * @param {string} user - The username.
     * @param {string} token - The token.
     * @param {VerdaccioAccessCallback} cb - The callback.
     *
     * @see {@link https://verdaccio.org/docs/en/plugin-auth#authentication-callback}
     */
    authenticate (user, token, cb) {
        const identity = () => {
            return this.verifyUserIdentity(user, token).then(() => {
                return this.verifyOrganization(user)
            })
        }

        this.cache.get(`identity_${user}`, identity).then(() => {
            return this.getUserTeams(user)
        }).then((teams) => {
            cb(null, teams)

        // Handle errors
        }).catch((e) => {
            let loginState
            const message = e.message ? e.message : 'Unknown error'

            if (e instanceof AuthenticationError) {
                loginState = e.loginState
                this.logger.warn({ user, message }, 'Unable to authenticate user @{user}: @{message}')
            } else {
                loginState = null
                this.logger.fatal({ message }, 'Authentication system error: @{message}')
            }

            /* The verdaccio callback is a bit weird.
            * If `error` is a truthy value, but has a `message` attribute then
            * Verdaccio will return a 401 status, regardless of the failure reason.
            * It will return a 500 status if there is no `message` attribute
            * on the error value.
            *
            * BUT, we already indicate whether it should be a 401 vs 500 via the second
            * parameter to the callback. So, if `loginState` is a non-null value,
            * then the value of `loginState` determines if it's a 401 or 200 and we can
            * set `error` to null, or if `loginState` is null then it's a 500 error and
            * we set `error` to a truthy value without a `message` attribute (in this
            * case, we just use `true`).
            */
            const error = loginState !== null ? null : true
            cb(error, loginState)
        })
    }

    /**
     * Get the list of teams the user is a member of.
     *
     * @param {string} user - The user to check
     * @returns {Promise<Array<string>>} A Promise of the list of teams for this user.
     */
    getUserTeams (user) {
        this.logger.trace({ user }, 'Getting teams for @{user}')
        return this.getOrganizationTeams().then((allTeams) => {
            return reduce(allTeams, (userTeams, users, team) => {
                if (includes(users, user)) {
                    userTeams.push(team)
                }
                return userTeams
            }, [this.organization])
        })
    }

    /**
     * Get the list of the organization teams.
     *
     * @returns {Promise<Teams>} A Promise of the list of teams of the organization.
     */
    getOrganizationTeams () {
        this.logger.trace({ organization: this.organization }, 'Getting teams for @{organization}')
        const query = {
            organization: {
                __args: {
                    login: this.organization
                },
                teams: {
                    edges: {
                        node: {
                            name: true,
                            members: {
                                __args: {
                                    membership: enumValue('ALL')
                                },
                                nodes: {
                                    login: true
                                }
                            }
                        }
                    }
                }
            }
        }

        const organizationTeams = () => {
            return this.client.getAll(query, 'organization.teams').then((result) => {
                return reduce(result.organization.teams.edges, (allTeams, edge) => {
                    allTeams[edge.node.name] = map(edge.node.members.nodes, n => n.login)
                    return allTeams
                }, {})
            })
        }

        return this.cache.get('organizationTeams', organizationTeams)
    }

    /**
     * Check if the user is part of the organization.
     *
     * @param {string} user - The user to check.
     * @returns {Promise<boolean>} A Promise of the result.
     */
    verifyOrganization (user) {
        this.logger.trace({ user }, 'Verifying organization for @{user}')

        const query = this.organizationQuery({
            membersWithRole: {
                edges: {
                    node: {
                        login: true
                    }
                }
            }
        })

        return this.client.getAll(query, 'organization.membersWithRole').then((result) => {
            const members = map(result.organization.membersWithRole.edges, (edge) => edge.node.login)

            if (includes(members, user)) {
                return true
            } else {
                throw new AuthenticationError('User not part of organization', false)
            }
        })
    }

    verifyUserIdentity (user, token) {
        this.logger.trace({ user }, 'Verifying identity for @{user}')

        const userClient = new GraphQLClient(token, this.logger)

        const query = {
            viewer: {
                login: true
            }
        }

        return userClient.get(query).catch((e) => {
            if (has(e, 'status') && e.status === 401) {
                throw new AuthenticationError('Invalid token', false)
            } else {
                throw new AuthenticationError(e.message, null)
            }
        }).then((response) => {
            if (response.viewer.login === user) {
                return true
            } else {
                throw new AuthenticationError('Username does not match token', false)
            }
        })
    }

    /**
     * Is the user allowed to access this package?
     *
     * @param { RemoteUser } user - The user.
     * @param { PackageAccess } pkg - The package.
     * @param {VerdaccioAccessCallback} cb - The success callback.
     */
    // eslint-disable-next-line camelcase
    allow_access (user, pkg, cb) {
        this.packagePermissionsForUserForPackage(user, pkg.name).then((permissions) => {
            this.logger.trace({ result: permissions.has(readPermission) }, 'user has access permission for package? @{result}')
            this.logger.trace({ user }, 'user:@{user}')
            this.logger.trace({ permission: readPermission }, 'permission:@{permission}')
            this.logger.trace({ pkg }, 'pkg:@{pkg}')
            cb(null, permissions.has(readPermission))
        }).catch((err) => {
            cb(err, undefined)
        })
    }

    /**
     * Is the user allowed to publish this package?
     *
     * @param { RemoteUser } user - The user.
     * @param { PackageAccess } pkg - The package.
     * @param {VerdaccioAccessCallback} cb - The success callback.
     */
    // eslint-disable-next-line camelcase
    allow_publish (user, pkg, cb) {
        this.packagePermissionsForUserForPackage(user, pkg.name).then((permissions) => {
            this.logger.trace({ result: permissions.has(writePermission) }, 'user has publish permission for package? @{result}')
            this.logger.trace({ user }, 'user:@{user}')
            this.logger.trace({ permission: writePermission }, 'permission:@{permission}')
            this.logger.trace({ pkg }, 'pkg:@{pkg}')
            cb(null, permissions.has(writePermission))
        }).catch((err) => {
            cb(err, undefined)
        })
    }

    /**
     * Is the user allowed to unpublish this package?
     *
     * @param { RemoteUser } user - The user.
     * @param { PackageAccess } pkg - The package.
     * @param {VerdaccioAccessCallback} cb - The success callback.
     */
    // eslint-disable-next-line camelcase
    allow_unpublish (user, pkg, cb) {
        // If you can publish, you can unpublish
        this.allow_publish(user, pkg, cb)
    }

    /* istanbul ignore next */
    adduser (user, password, cb) {
        // We don't handle adding users
        cb(null, false)
    }

    /**
     * @typedef { Set<string> } PermissionSet
     */

    /**
     * @typedef { Object<string, PermissionSet> } UserPackagePermissions
     */

    /**
     * What permissions does this user have for this package?
     *
     * @param { RemoteUser } user - The user.
     * @param { string } pkgName - The package.
     * @returns { Promise<PermissionSet> } - The set of permissions.
     */
    packagePermissionsForUserForPackage (user, pkgName) {
        return this.packagePermissionsForUser(user).then((packagePermissions) => {
            return packagePermissions[pkgName] || new Set()
        })
    }

    /**
     * What permissions does this user have for all packages?
     *
     * @param { RemoteUser } user - The user.
     * @returns { Promise<UserPackagePermissions> } - The set of permissions.
     */
    packagePermissionsForUser (user) {
        // Fetch the list of packages
        const packagePermissionsForUser = () => {
            return this.packageNames().then((packageNames) => {
                // Get the list of repositories
                return this.repositoryPermissions().then((allRepositoryPermissions) => {
                    /** @type {UserPackagePermissions} */
                    const packagePermissionsForUser = {}

                    forOwn(packageNames, (repoName, packageName) => {
                        let packagePermissions = new Set()

                        // Unknown repository -> no permissions
                        /* istanbul ignore next */
                        if (!allRepositoryPermissions[repoName]) {
                            return
                        }

                        const repositoryPermissions = allRepositoryPermissions[repoName]
                        const userPackagePermissions = repositoryPermissions.users[user.name]

                        // If the user has direct permissions, add them
                        /* istanbul ignore else */
                        if (userPackagePermissions) {
                            packagePermissions = clone(userPackagePermissions)
                        }

                        // Get the indirect permissions for the user, via their team
                        user.real_groups.forEach((group) => {
                            packagePermissions = setUnion(packagePermissions, new Set(repositoryPermissions.teams[group]))
                        })

                        /* istanbul ignore else */
                        if (packagePermissions.size > 0) {
                            packagePermissionsForUser[packageName] = packagePermissions
                        }
                    })

                    this.logger.trace({ packagePermissionsForUser, user }, 'packagePermissionsForUser: @{user} - @{packagePermissionsForUser}')

                    return packagePermissionsForUser
                })
            })
        }

        return this.cache.get(`packagePermissionsForUser_${user.name}`, packagePermissionsForUser)
    }

    /**
     * @typedef {Object} RepositoryPermissions
     * @property {Object<string, PermissionSet>} users - A map of users to permission sets.
     * @property {Object<string, PermissionSet>} teams - A map of teams to permission sets.
     */

    /**
     * Returns the permissions for all of the repositories.
     *
     * @returns {Promise<Object<string, RepositoryPermissions>>} - A map of repositories to repository permissions.
     */
    repositoryPermissions () {
        this.logger.trace('Getting repository permissions')

        const organizationType = 'Organization'
        const teamType = 'Team'
        const repositoryType = 'Repository'

        const query = this.organizationQuery({
            repositories: {
                edges: {
                    node: {
                        name: true,
                        collaborators: {
                            edges: {
                                node: {
                                    login: true
                                },
                                permissionSources: {
                                    permission: true,
                                    source: {
                                        __typename: true,
                                        __on: [
                                            {
                                                __typeName: organizationType,
                                                login: true
                                            },
                                            {
                                                __typeName: teamType,
                                                name: true
                                            },
                                            {
                                                __typeName: repositoryType,
                                                name: true
                                            }
                                        ]
                                    }
                                }
                            }
                        }
                    }
                }
            }
        })

        const repositoryPermissions = () => {
            return this.client.getAll(query, 'organization.repositories').then((response) => {
                const repositoryPermissions = reduce(response.organization.repositories.edges, (repositories, repository) => {
                    const permissions = { users: {}, teams: {} }

                    repositories[repository.node.name] = permissions

                    forEach(repository.node.collaborators.edges, (collaborator) => {
                        const username = collaborator.node.login

                        // We want to build up the set of permissions for the user
                        const userRepoPermissions = reduce(collaborator.permissionSources, (sourcePermissions, permissionSource) => {
                            const mappedPermission = this.mapPermission(permissionSource.permission)

                            // Here we deal with permissions that come from the Repo, or the Organization
                            if (permissionSource.source.__typename === organizationType || permissionSource.source.__typename === repositoryType) {
                                sourcePermissions = setUnion(sourcePermissions, mappedPermission)

                            // Here we deal with permissions from the teams
                            // We want to build up the set of permissions for a team
                            // by collect the permissions that a user acquires through membership
                            // of that team
                            } else
                            /* istanbul ignore else */ if (permissionSource.source.__typename === teamType) {
                                const teamName = permissionSource.source.name
                                permissions.teams[teamName] = setUnion(permissions.teams[teamName] || new Set(), mappedPermission)
                            }

                            // These are the user permissions
                            return sourcePermissions
                        }, new Set())

                        permissions.users[username] = userRepoPermissions
                    })

                    return repositories
                }, {})

                this.logger.trace({ repositoryPermissions }, 'repositoryPermissions: @{repositoryPermissions}')

                return repositoryPermissions
            })
        }

        return this.cache.get('repositoryPermissions', repositoryPermissions)
    }

    /**
     * Extracts the package name from the package.json content.
     *
     * @param {string} packageFileContent - The contents of a package.json file.
     * @returns {string} - The name of the package.
     */
    static getPackageName (packageFileContent) {
        try {
            const packageFile = JSON.parse(packageFileContent)
            return packageFile.name
        } catch (err) {
            return undefined
        }
    }

    /**
     * Retrieve the list of package names and associated repositories.
     *
     * @returns {Promise<Object<string, string>>} - A promise of an object mapping package names to repositories.
     */
    packageNames () {
        this.logger.trace('Getting package names')

        const packageNames = () => {
            return this.packageFiles().then((packageFiles) => {
                /** @type {Object<string, string>} */
                const packageNames = {}

                forOwn(packageFiles, (packageFileContent, repositoryName) => {
                    if (!packageFileContent) return
                    if (this.includeRepositories && !includes(this.includeRepositories, repositoryName)) return
                    if (this.excludeRepositories && includes(this.excludeRepositories, repositoryName)) return
                    if (this.repositoryPattern && !this.repositoryPattern.test(repositoryName)) return

                    const packageName = GithubAuthPlugin.getPackageName(packageFileContent)

                    if (packageName) {
                        packageNames[packageName] = repositoryName
                    }
                })

                this.logger.trace({ packageNames }, 'packageNames: @{packageNames}')

                return packageNames
            })
        }

        return this.cache.get('packageNames', packageNames)
    }

    /**
     * Retrieves the package.json contents for each repository.
     *
     * @returns {Promise<Object<string, string>>} - A promise of an object mapping repository names to
     * the contents of the package.json in the repository.
     */
    packageFiles () {
        this.logger.trace('Getting packages files')

        const query = this.organizationQuery({
            repositories: {
                edges: {
                    node: {
                        name: true,
                        object: {
                            __args: {
                                expression: `master:${packageJson}`
                            },
                            __on: {
                                __typeName: 'Blob',
                                text: true
                            }
                        }
                    }
                }
            }
        })

        return this.cache.get('packageFiles', () => {
            return this.client.getAll(query, 'organization.repositories').then((result) => {
                const packageFiles = reduce(result.organization.repositories.edges, (packageMap, edge) => {
                    packageMap[edge.node.name] = get(edge, 'node.object.text', null)
                    return packageMap
                }, {})

                this.logger.trace({ packageFiles }, 'packageFiles: @{packageFiles}')

                return packageFiles
            })
        })
    }

    organizationQuery (subQuery) {
        return {
            organization: {
                __args: {
                    login: this.organization
                },
                ...subQuery
            }
        }
    }
}

export default GithubAuthPlugin
