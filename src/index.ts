import { GraphQLClient, PageInfoExtractor } from './graphql'
import Cache from './cache'
import { RateLimiter } from 'limiter'
import { map, includes, reduce, forOwn, clone } from 'lodash'
import {
    AllowAccess,
    AuthError,
    AuthCallback,
    AuthAccessCallback,
    RemoteUser,
    PackageAccess,
    Logger,
    PluginOptions,
    IPluginAuth
} from '@verdaccio/types'
import * as s from './schemaTypes'
import { RequestError } from '@octokit/request-error'
import { PackageJson } from 'types-package-json'

type LoginState = true | false | null
type MaybeRequestError = Error | RequestError
type MaybeAuthenticationError = MaybeRequestError | AuthenticationError

type Definite<T> = Exclude<T, null | undefined>

export class APIError extends Error {
    constructor(message: string) {
        super(message)
        // This is due to https://github.com/Microsoft/TypeScript/wiki/Breaking-Changes#extending-built-ins-like-error-array-and-map-may-no-longer-work
        Object.setPrototypeOf(this, APIError.prototype)
    }
}

export class AuthenticationError extends Error {
    loginState: LoginState

    constructor(message: string, loginState: LoginState) {
        super(message)
        // This is due to https://github.com/Microsoft/TypeScript/wiki/Breaking-Changes#extending-built-ins-like-error-array-and-map-may-no-longer-work
        Object.setPrototypeOf(this, AuthenticationError.prototype)

        // Ensure the name of this error is the same as the class name
        this.name = this.constructor.name

        this.loginState = loginState

        // This clips the constructor invocation from the stack trace.
        // It's not absolutely essential, but it does make the stack trace a little nicer.
        Error.captureStackTrace(this, this.constructor)
    }
}

/**
 * The union of two sets.
 *
 * @param a - The first set.
 * @param b - The second set.
 * @returns The union.
 */
export const setUnion = function <T>(a: Set<T>, b: Set<T>): Set<T> {
    return new Set<T>([...a, ...b])
}

const readPermission = 'read'
const writePermission = 'write'

type PackagePermission = typeof readPermission | typeof writePermission
type PackagePermissions = Set<PackagePermission>
type PackagesPermissions = Record<string, PackagePermissions>

type RepositoryPermissions = {
    teams: Record<string, PackagePermissions>
    users: Record<string, PackagePermissions>
}

export type Team = {
    name: string
    members: Member[]
}

type User = string
type Member = User

export interface GithubAuthPluginConfig {
    organization: string
    token: string
    rateLimiter?: RateLimiter
    repositoryPattern?: RegExp | string
    includeRepositories?: string[]
    excludeRepositories?: string[]
}

export type GithubAuthPluginOptions = PluginOptions<GithubAuthPluginConfig>

/**
 * Custom Verdaccio Authenticate Plugin.
 */
class GithubAuthPlugin implements IPluginAuth<AllowAccess> {
    config: GithubAuthPluginConfig
    logger: Logger

    organization: string
    includeRepositories?: string[]
    excludeRepositories?: string[]
    repositoryPattern?: RegExp

    client: GraphQLClient
    cache: Cache

    /**
     * Init.
     *
     * @param {GithubAuthPluginConfig} config - The plugin config.
     * @param {PluginOptions} options - The plugin options.
     */
    constructor(config: GithubAuthPluginConfig, options: GithubAuthPluginOptions) {
        const { organization, token, rateLimiter } = config

        this.config = config
        this.logger = options.logger

        this.organization = organization
        this.logger = options.logger

        this.includeRepositories = config.includeRepositories
        this.excludeRepositories = config.excludeRepositories
        this.repositoryPattern = new RegExp(config.repositoryPattern || /.*/)

        this.client = new GraphQLClient(token, this.logger, rateLimiter)
        this.cache = new Cache()

        return this
    }

    /**
     * Maps a Github permission to a package permission.
     *
     * @param githubPermission - The Github permission.
     * @returns - The package permission.
     */
    mapPermission(
        githubPermission: s.RepositoryPermission | s.DefaultRepositoryPermissionField | undefined | null
    ): PackagePermissions {
        switch (githubPermission) {
            case 'ADMIN':
            case 'MAINTAIN':
            case 'WRITE':
                return new Set([readPermission, writePermission])
            case 'TRIAGE':
            case 'READ':
                return new Set([readPermission])
            case 'NONE':
                return new Set([])
            default:
                throw new APIError(`Unknown permission type`)
        }
    }

    /**
     * Authenticates the user for the given token.
     *
     * - Ensures that the token is valid and belongs to the user.
     * - Ensures that the user belongs to the organization.
     * - Retrieves the list of teams to which the user belongs.
     *
     * @param user - The username.
     * @param token - The token.
     * @param cb - The callback.
     *
     * See https://verdaccio.org/docs/en/plugin-auth#authentication-callback.
     */
    authenticate(user: string, token: string, cb: AuthCallback): void {
        const identity = () => {
            return this.verifyUserIdentity(user, token).then(() => {
                return this.verifyOrganization(user)
            })
        }

        this.cache
            .get(`identity_${user}`, identity)
            .then(() => this.getUserTeams(user))
            .then(teams => {
                // If we're successful, return the list of groups
                cb(
                    null,
                    map(teams, t => t.name)
                )
            })
            // Handle errors
            .catch((e: MaybeAuthenticationError) => {
                const message = e.message ? e.message : 'Unknown error'
                let status: number
                let name: string

                if (e instanceof AuthenticationError) {
                    this.logger.warn({ user, message }, 'Unable to authenticate user @{user}: @{message}')
                    status = 401
                    name = 'Authentication error'
                } else {
                    this.logger.error({ message }, 'Authentication system error: @{message}')
                    status = 500
                    name = 'Internal Error'
                }

                const authError: AuthError = {
                    message,
                    status,
                    code: status,
                    statusCode: status,
                    name,
                    expose: true
                }

                cb(authError, false)
            })
    }

    /**
     * Get the list of teams the user is a member of.
     *
     * @param user - The user to check
     * @returns A Promise of the list of teams for this user.
     */
    getUserTeams(user: string): Promise<Team[]> {
        this.logger.trace({ user }, 'Getting teams for @{user}')
        return this.getOrganizationTeams().then(allTeams => {
            return reduce(
                allTeams,
                (userTeams, team) => {
                    if (includes(team.members, user)) {
                        userTeams.push(team)
                    }
                    return userTeams
                },

                // Create a virtual team for the org
                <Team[]>[
                    {
                        name: this.organization,
                        members: [user]
                    }
                ]
            )
        })
    }

    /**
     * Get the list of the organization teams.
     *
     * @returns A Promise of the list of teams of the organization.
     */
    getOrganizationTeams(): Promise<Team[]> {
        this.logger.trace({ organization: this.organization }, 'Getting teams for @{organization}')
        const organizationTeams = () => {
            /* istanbul ignore next */
            const pageInfo: PageInfoExtractor<s.GetOrganizationTeamsQuery> = page => page.organization?.teams.pageInfo

            return this.client
                .getAll<s.GetOrganizationTeamsQuery, s.GetOrganizationTeamsQueryVariables>(
                    s.GetOrganizationTeams,
                    { login: this.organization },
                    pageInfo
                )
                .then(resultPages => {
                    const teams: Team[] = []

                    // Get the teams from all the pages
                    resultPages.forEach(page => {
                        /* istanbul ignore next */
                        const pageEdges = page.organization?.teams.edges ?? []
                        pageEdges.forEach(edge => {
                            /* istanbul ignore next */
                            if (!edge?.node) {
                                return
                            }
                            /* istanbul ignore next */
                            const members = edge.node.members.nodes ?? []

                            teams.push({
                                name: edge.node.name,
                                // We use the Definite cast to overcome an excessively cautious code generator
                                // that assumes we can have an array of null values
                                members: map(members, n => (<Definite<typeof n>>n).login.toLowerCase())
                            })
                        })
                    })

                    return teams
                })
        }

        return this.cache.get('organizationTeams', organizationTeams)
    }

    /**
     * Check if the user is part of the organization.
     *
     * @param user - The user to check.
     * @returns A Promise of the result.
     */
    verifyOrganization(user: string): Promise<boolean> {
        this.logger.trace({ user }, 'Verifying organization for @{user}')

        /* istanbul ignore next */
        const pageInfo: PageInfoExtractor<s.VerifyOrganizationQuery> = page => page.organization?.membersWithRole.pageInfo

        return this.client
            .getAll<s.VerifyOrganizationQuery, s.VerifyOrganizationQueryVariables>(
                s.VerifyOrganization,
                { login: this.organization },
                pageInfo
            )
            .then(results => {
                const members: string[] = []

                results.forEach(page => {
                    /* istanbul ignore next */
                    const edges = page.organization?.membersWithRole.edges ?? []
                    edges.forEach(edge => {
                        /* istanbul ignore next */
                        if (!edge?.node) {
                            return
                        }

                        members.push(edge.node.login.toLowerCase())
                    })
                })

                if (includes(members, user)) {
                    return true
                } else {
                    throw new AuthenticationError('User not part of organization', false)
                }
            })
    }

    verifyUserIdentity(user: string, token: string): Promise<void> {
        this.logger.trace({ user }, 'Verifying identity for @{user}')

        const userClient = new GraphQLClient(token, this.logger)

        return userClient
            .get<s.VerifyUserIdentityQuery, s.VerifyUserIdentityQueryVariables>(s.VerifyUserIdentity)
            .catch((e: MaybeRequestError) => {
                if ('status' in e && e.status === 401) {
                    throw new AuthenticationError('Invalid token', false)
                } else {
                    throw new AuthenticationError(e.message, null)
                }
            })
            .then(response => {
                if (response.viewer.login.toLowerCase() !== user.toLowerCase()) {
                    throw new AuthenticationError('Username does not match token', false)
                }
            })
    }

    /**
     * Is the user allowed to access this package?
     *
     * @param user - The user.
     * @param pkg - The package.
     * @param cb - The success callback.
     */
    // eslint-disable-next-line camelcase
    allow_access(user: RemoteUser, pkg: PackageAccess & AllowAccess, cb: AuthAccessCallback): void {
        this.packagePermissionsForUserForPackage(user, pkg.name)
            .then(permissions => {
                this.logger.trace(
                    { result: permissions.has(readPermission) },
                    'user has access permission for package? @{result}'
                )
                this.logger.trace({ user }, 'user:@{user}')
                this.logger.trace({ permission: readPermission }, 'permission:@{permission}')
                this.logger.trace({ pkg }, 'pkg:@{pkg}')
                cb(null, permissions.has(readPermission))
            })
            .catch(err => {
                cb(err, false)
            })
    }

    /**
     * Is the user allowed to publish this package?
     *
     * @param user - The user.
     * @param pkg - The package.
     * @param cb - The success callback.
     */
    // eslint-disable-next-line camelcase
    allow_publish(user: RemoteUser, pkg: PackageAccess & AllowAccess, cb: AuthAccessCallback): void {
        this.packagePermissionsForUserForPackage(user, pkg.name)
            .then(permissions => {
                this.logger.trace(
                    { result: permissions.has(writePermission) },
                    'user has publish permission for package? @{result}'
                )
                this.logger.trace({ user }, 'user:@{user}')
                this.logger.trace({ permission: writePermission }, 'permission:@{permission}')
                this.logger.trace({ pkg }, 'pkg:@{pkg}')
                cb(null, permissions.has(writePermission))
            })
            .catch(err => {
                cb(err, false)
            })
    }

    /**
     * Is the user allowed to unpublish this package?
     *
     * @param user - The user.
     * @param pkg - The package.
     * @param cb - The success callback.
     */
    // eslint-disable-next-line camelcase
    allow_unpublish(user: RemoteUser, pkg: PackageAccess & AllowAccess, cb: AuthAccessCallback): void {
        // If you can publish, you can unpublish
        this.allow_publish(user, pkg, cb)
    }

    /* istanbul ignore next */
    adduser(_user: string, _password: string, cb: AuthCallback): void {
        // We don't handle adding users
        cb(null, false)
    }

    /**
     * What permissions does this user have for this package?
     *
     * @param user - The user.
     * @param pkgName - The package.
     * @returns The set of permissions.
     */
    packagePermissionsForUserForPackage(user: RemoteUser, pkgName: string): Promise<PackagePermissions> {
        return this.packagePermissionsForUser(user).then(packagePermissions => {
            return packagePermissions[pkgName] || new Set()
        })
    }

    /**
     * What permissions does this user have for all packages?
     *
     * @param user - The user.
     * @returns - The permissions for all packages.
     */
    packagePermissionsForUser(user: RemoteUser): Promise<PackagesPermissions> {
        const username = <string>user.name

        // Fetch the list of packages
        const packagePermissionsForUser = () => {
            return this.packageNames().then(packageNames => {
                // Get the list of repositories
                return this.repositoryPermissions().then(allRepositoryPermissions => {
                    const packagePermissionsForUser: PackagesPermissions = {}

                    forOwn(packageNames, (repoName, packageName) => {
                        let packagePermissions: PackagePermissions = new Set()

                        // Unknown repository -> no permissions
                        /* istanbul ignore next */
                        if (!allRepositoryPermissions[repoName]) {
                            return
                        }

                        const repositoryPermissions = allRepositoryPermissions[repoName]
                        const userPackagePermissions = repositoryPermissions.users[username]

                        // If the user has direct permissions, add them
                        /* istanbul ignore else */
                        if (userPackagePermissions) {
                            packagePermissions = clone(userPackagePermissions)
                        }

                        // Get the indirect permissions for the user, via their team
                        user.real_groups.forEach(group => {
                            packagePermissions = setUnion(packagePermissions, new Set(repositoryPermissions.teams[group]))
                        })

                        /* istanbul ignore else */
                        if (packagePermissions.size > 0) {
                            packagePermissionsForUser[packageName] = packagePermissions
                        }
                    })

                    this.logger.trace(
                        { packagePermissionsForUser, user },
                        'packagePermissionsForUser: @{user} - @{packagePermissionsForUser}'
                    )

                    return packagePermissionsForUser
                })
            })
        }

        return this.cache.get(`packagePermissionsForUser_${<string>user.name}`, packagePermissionsForUser)
    }

    /**
     * Returns the permissions for all of the repositories.
     *
     * @returns A map of repositories to repository permissions.
     */
    repositoryPermissions(): Promise<Record<string, RepositoryPermissions>> {
        this.logger.trace('Getting repository permissions')

        const repositoryPermissions = () => {
            /* istanbul ignore next */
            const pageInfo: PageInfoExtractor<s.GetOrganizationRepositoryPermissionsQuery> = page =>
                page.organization?.repositories.pageInfo

            return this.client
                .getAll<s.GetOrganizationRepositoryPermissionsQuery, s.GetOrganizationRepositoryPermissionsQueryVariables>(
                    s.GetOrganizationRepositoryPermissions,
                    { login: this.organization },
                    pageInfo
                )
                .then(response => {
                    const repositoryPermissions: Record<string, RepositoryPermissions> = {}

                    response.forEach(page => {
                        /* istanbul ignore next */
                        const repos = page.organization?.repositories.edges ?? []
                        repos.forEach(repo => {
                            // A little bit of type-wrangling
                            repo = <Definite<typeof repo>>repo
                            let node = repo.node
                            node = <Definite<typeof node>>node

                            const permissions: RepositoryPermissions = { users: {}, teams: {} }
                            repositoryPermissions[node.name] = permissions

                            /* istanbul ignore next */
                            const collaborators = node.collaborators?.edges ?? []

                            collaborators.forEach(collaborator => {
                                collaborator = <Definite<typeof collaborator>>collaborator
                                const username = collaborator.node.login.toLowerCase()
                                /* istanbul ignore next */
                                const permissionSources = collaborator.permissionSources ?? []
                                let userPermissions = new Set<PackagePermission>()
                                let teamName: string

                                permissionSources.forEach(source => {
                                    const mappedPermission = this.mapPermission(source.permission)

                                    switch (source.source.__typename) {
                                        case 'Organization':
                                        case 'Repository':
                                            // Here we deal with permissions that come from the Repo, or the Organization
                                            userPermissions = setUnion(userPermissions, mappedPermission)
                                            break
                                        case 'Team':
                                            // Here we deal with permissions from the teams
                                            // We want to build up the set of permissions for a team
                                            // by collect the permissions that a user acquires through membership
                                            // of that team
                                            teamName = source.source.name
                                            permissions.teams[teamName] = setUnion(
                                                permissions.teams[teamName] || new Set(),
                                                mappedPermission
                                            )
                                    }
                                })

                                permissions.users[username] = userPermissions
                            })
                        })
                    })

                    this.logger.trace({ repositoryPermissions }, 'repositoryPermissions: @{repositoryPermissions}')

                    return repositoryPermissions
                })
        }

        return this.cache.get('repositoryPermissions', repositoryPermissions)
    }

    /**
     * Extracts the package name from the package.json content.
     *
     * @param packageFileContent - The contents of a package.json file.
     * @returns The name of the package.
     */
    static getPackageName(packageFileContent: string): string | undefined {
        try {
            const packageFile = <PackageJson>JSON.parse(packageFileContent)
            return packageFile.name
        } catch (err) {
            return undefined
        }
    }

    /**
     * Retrieve the list of package names and associated repositories.
     *
     * @returns - A promise of an object mapping package names to repositories.
     */
    packageNames(): Promise<Record<string, string>> {
        this.logger.trace('Getting package names')

        const packageNames = () => {
            return this.packageFiles().then(packageFiles => {
                const packageNames: Record<string, string> = {}

                forOwn(packageFiles, (packageFileContent, repositoryName) => {
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
     * @returns A promise of an object mapping repository names to the contents of the package.json in the repository.
     */
    packageFiles(): Promise<Record<string, string>> {
        this.logger.trace('Getting packages files')

        return this.cache.get('packageFiles', () => {
            /* istanbul ignore next */
            const pageInfo: PageInfoExtractor<s.GetOrganizationPackageFilesQuery> = page =>
                page.organization?.repositories.pageInfo

            return this.client
                .getAll<s.GetOrganizationPackageFilesQuery, s.GetOrganizationPackageFilesQueryVariables>(
                    s.GetOrganizationPackageFiles,
                    { login: this.organization },
                    pageInfo
                )
                .then(results => {
                    const packageFiles: Record<string, string> = {}

                    results.forEach(page => {
                        /* istanbul ignore next */
                        const repos = page.organization?.repositories.edges ?? []
                        repos.forEach(repo => {
                            // It's not going to be an array of null values...
                            repo = <Definite<typeof repo>>repo

                            /* istanbul ignore next */
                            if (!repo.node?.object) {
                                return
                            }

                            /* istanbul ignore else */
                            if (repo.node.object.__typename === 'Blob' && repo.node.object.text) {
                                packageFiles[repo.node.name] = repo.node.object.text
                            }
                        })
                    })

                    this.logger.trace({ packageFiles }, 'packageFiles: @{packageFiles}')

                    return packageFiles
                })
        })
    }
}

export default GithubAuthPlugin
