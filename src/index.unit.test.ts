/* eslint-disable jest/no-done-callback */
import GithubAuthPlugin, {
    AuthenticationError,
    APIError,
    setUnion,
    GithubAuthPluginConfig,
    GithubAuthPluginOptions,
    Team
} from './index'
import { GraphQLClient } from './graphql'
import { Logger, Config, RemoteUser } from '@verdaccio/types'
import * as s from './schemaTypes'
import { map } from 'lodash'

jest.mock('./graphql')

type MockedGraphQLClient = jest.Mock<GraphQLClient>
const MockedGraphQLClient = <MockedGraphQLClient>(<unknown>GraphQLClient)

type MockedGraphQLClientInstance = jest.Mocked<GraphQLClient>

const readPermission = 'read'
const writePermission = 'write'

type Permission = typeof readPermission | typeof writePermission
type GithubPermissionKey = s.RepositoryPermission | s.DefaultRepositoryPermissionField

const permissionsMap: Record<GithubPermissionKey, Set<Permission>> = {
    ADMIN: new Set([readPermission, writePermission]),
    WRITE: new Set([readPermission, writePermission]),
    READ: new Set([readPermission]),
    MAINTAIN: new Set([readPermission, writePermission]),
    TRIAGE: new Set([readPermission]),
    NONE: new Set([])
}

class MockHTTPError extends Error {
    status: number

    constructor(message: string, status: number) {
        super(message)
        this.status = status
    }
}

const expectSetsToBeStrictlyEqual = <T>(a: Set<T>, b: Set<T>) => {
    expect([...a].sort()).toStrictEqual([...b].sort())
}

describe('index.js unit tests', () => {
    describe('setUnion', () => {
        it('creates the union of two sets', () => {
            expect([...setUnion(new Set([1, 2]), new Set([1, 2, 3]))].sort()).toStrictEqual([1, 2, 3])
        })
    })

    describe('GithubAuthPlugin', () => {
        let plugin: GithubAuthPlugin
        let mockedClient: MockedGraphQLClientInstance

        describe('methods', () => {
            let options: GithubAuthPluginOptions

            const config = <GithubAuthPluginConfig>{
                organization: 'my-org',
                token: 'my-token'
            }

            beforeEach(() => {
                options = {
                    logger: <Logger>(<unknown>{
                        warn: jest.fn(),
                        trace: jest.fn(),
                        error: jest.fn()
                    }),
                    config: <GithubAuthPluginConfig & Config>config
                }

                plugin = new GithubAuthPlugin(config, options)
                mockedClient = <MockedGraphQLClientInstance>(<unknown>plugin.client)
                MockedGraphQLClient.mockReset()
            })

            describe('mapPermission', () => {
                it.each(<GithubPermissionKey[]>Object.keys(permissionsMap))('correctly maps %s', perm => {
                    expectSetsToBeStrictlyEqual(plugin.mapPermission(perm), permissionsMap[perm])
                })

                it('raises an error for unknown permissions', () => {
                    expect(() => {
                        plugin.mapPermission(null)
                    }).toThrow(APIError)
                })
            })

            describe('authenticate', () => {
                it('fails on invalid user', done => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'verifyUserIdentity').mockRejectedValue(new AuthenticationError('Invalid user', false))

                    plugin.authenticate('user', 'token', (err, groups) => {
                        expect(err).not.toBeNull()
                        expect(groups).toStrictEqual(false)
                        done()
                    })
                })

                it('fails if user does not belong to the organisation', done => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'verifyUserIdentity').mockResolvedValue()
                    jest.spyOn(plugin, 'verifyOrganization').mockRejectedValue(new AuthenticationError('Org error', false))

                    plugin.authenticate('user', 'token', (err, groups) => {
                        expect(err).not.toBeNull()
                        expect(groups).toStrictEqual(false)
                        done()
                    })
                })

                it('fails if there is an error retrieving the teams', done => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'verifyUserIdentity').mockResolvedValue()
                    jest.spyOn(plugin, 'verifyOrganization').mockResolvedValue(true)
                    jest.spyOn(plugin, 'getUserTeams').mockRejectedValue(new Error('Some error'))

                    plugin.authenticate('user', 'token', (err, groups) => {
                        expect(err).not.toBeNull()
                        expect(groups).toStrictEqual(false)
                        done()
                    })
                })

                it('fails if there is an internal error', done => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'verifyUserIdentity').mockRejectedValue(new Error())

                    plugin.authenticate('user', 'token', (err, groups) => {
                        expect(err).not.toBeNull()
                        expect(groups).toStrictEqual(false)
                        done()
                    })
                })

                it('succeeds if the user is valid', done => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'verifyUserIdentity').mockResolvedValue()
                    jest.spyOn(plugin, 'verifyOrganization').mockResolvedValue(true)

                    const teams: Team[] = [{ name: 'Team', members: [] }]

                    jest.spyOn(plugin, 'getUserTeams').mockResolvedValue(teams)

                    plugin.authenticate('user', 'token', (err, groups) => {
                        expect(err).toBeNull()
                        expect(groups).toStrictEqual(map(teams, t => t.name))
                        done()
                    })
                })
            })

            describe('verifyUserIdentity', () => {
                it('uses the user token', () => {
                    expect.assertions(2)

                    // @ts-expect-error, Overriding prototype
                    MockedGraphQLClient.mockImplementation(() => {
                        return {
                            get: () => {
                                return Promise.resolve()
                            }
                        }
                    })

                    return plugin
                        .verifyUserIdentity('user', 'token')
                        .catch(() => true)
                        .finally(() => {
                            expect(MockedGraphQLClient).toHaveBeenCalledTimes(1)
                            expect(MockedGraphQLClient).toHaveBeenCalledWith('token', options.logger)
                        })
                })

                it('throws an AuthenticationError(loginState=false) if token is invalid', () => {
                    expect.assertions(2)
                    const user = 'user'

                    // @ts-expect-error, Overriding prototype
                    MockedGraphQLClient.mockImplementation(() => {
                        return {
                            get: () => {
                                return Promise.reject(new MockHTTPError('Failed', 401))
                            }
                        }
                    })

                    return plugin.verifyUserIdentity(user, 'token').catch((err: AuthenticationError) => {
                        expect(err instanceof AuthenticationError).toStrictEqual(true)
                        expect(err.loginState).toStrictEqual(false)
                    })
                })

                it('throws an internal error if there is a unknown error', () => {
                    expect.assertions(2)
                    const user = 'user'

                    // @ts-expect-error, Overriding prototype
                    MockedGraphQLClient.mockImplementation(() => {
                        return {
                            get: () => {
                                return Promise.reject(new Error('Some error'))
                            }
                        }
                    })

                    return plugin.verifyUserIdentity(user, 'token').catch((err: AuthenticationError) => {
                        expect(err instanceof AuthenticationError).toStrictEqual(true)
                        expect(err.loginState).toBeNull()
                    })
                })

                it('returns true if the user matches the token in a case insensitive way', () => {
                    expect.assertions(1)
                    const user = 'Some-User'

                    const response: s.VerifyUserIdentityQuery = {
                        viewer: {
                            login: user
                        }
                    }

                    // @ts-expect-error, Overriding prototype
                    MockedGraphQLClient.mockImplementation(() => {
                        return {
                            get: () => {
                                return Promise.resolve(response)
                            }
                        }
                    })

                    return expect(plugin.verifyUserIdentity(user, 'token')).resolves.toBeUndefined()
                })

                it('throws an AuthenticationError(loginState=false) if user does not match token', () => {
                    expect.assertions(2)
                    const user = 'user'

                    const response: s.VerifyUserIdentityQuery = {
                        viewer: {
                            login: 'not user'
                        }
                    }

                    // @ts-expect-error, Overriding prototype
                    MockedGraphQLClient.mockImplementation(() => {
                        return {
                            get: () => {
                                return Promise.resolve(response)
                            }
                        }
                    })

                    return plugin.verifyUserIdentity(user, 'token').catch((err: AuthenticationError) => {
                        expect(err instanceof AuthenticationError).toStrictEqual(true)
                        expect(err.loginState).toStrictEqual(false)
                    })
                })
            })

            describe('getUserTeams', () => {
                it('returns the members team for a non admin user', () => {
                    expect.assertions(1)
                    const user = 'user'
                    const userTeam = 'members'
                    const notUserTeam = 'admins'

                    const response: s.GetOrganizationTeamsQuery[] = [
                        {
                            organization: {
                                teams: {
                                    pageInfo: {
                                        hasNextPage: false,
                                        endCursor: null
                                    },
                                    edges: [
                                        {
                                            node: {
                                                name: userTeam,
                                                members: {
                                                    nodes: [
                                                        {
                                                            login: user.toUpperCase()
                                                        }
                                                    ]
                                                }
                                            }
                                        },
                                        {
                                            node: {
                                                name: notUserTeam,
                                                members: {
                                                    nodes: []
                                                }
                                            }
                                        }
                                    ]
                                }
                            }
                        }
                    ]

                    MockedGraphQLClient.mockReset()
                    // @ts-expect-error, Overriding prototype
                    MockedGraphQLClient.mockImplementation(() => {
                        return {
                            getAll: (): Promise<s.GetOrganizationTeamsQuery[]> => {
                                return Promise.resolve(response)
                            }
                        }
                    })

                    // We have to do this here to ensure we're using the
                    // local GraphQL mock
                    plugin = new GithubAuthPlugin(config, options)

                    return plugin.getUserTeams(user).then(result => {
                        expect(result).toStrictEqual([
                            { name: config.organization, members: [user] },
                            { name: userTeam, members: [user] }
                        ])
                    })
                })
            })

            describe('verifyOrganization', () => {
                it('throws an AuthenticationError(loginState=false) if user is not in organization', () => {
                    expect.assertions(2)
                    const user = 'user'

                    const response: s.VerifyOrganizationQuery[] = [
                        {
                            organization: {
                                membersWithRole: {
                                    edges: [
                                        {
                                            node: {
                                                login: 'some_user'
                                            }
                                        }
                                    ],
                                    pageInfo: {
                                        hasNextPage: false,
                                        endCursor: null
                                    }
                                }
                            }
                        }
                    ]

                    // @ts-expect-error, Overriding prototype
                    MockedGraphQLClient.mockImplementation(() => {
                        return {
                            getAll: (): Promise<s.VerifyOrganizationQuery[]> => {
                                return Promise.resolve(response)
                            }
                        }
                    })

                    // We have to do this here to ensure we're using the
                    // local GraphQL mock
                    plugin = new GithubAuthPlugin(config, options)

                    return plugin.verifyOrganization(user).catch((err: AuthenticationError) => {
                        expect(err instanceof AuthenticationError).toStrictEqual(true)
                        expect(err.loginState).toStrictEqual(false)
                    })
                })

                it('returns true if user is in organization', () => {
                    expect.assertions(1)
                    const user = 'user'

                    const response: s.VerifyOrganizationQuery[] = [
                        {
                            organization: {
                                membersWithRole: {
                                    edges: [
                                        {
                                            node: {
                                                login: user.toUpperCase()
                                            }
                                        }
                                    ],
                                    pageInfo: {
                                        hasNextPage: false,
                                        endCursor: null
                                    }
                                }
                            }
                        }
                    ]

                    // @ts-expect-error, Overriding prototype
                    MockedGraphQLClient.mockImplementation(() => {
                        return {
                            getAll: (): Promise<s.VerifyOrganizationQuery[]> => {
                                return Promise.resolve(response)
                            }
                        }
                    })

                    // We have to do this here to ensure we're using the
                    // local GraphQL mock
                    plugin = new GithubAuthPlugin(config, options)

                    return plugin.verifyOrganization(user).then(result => {
                        expect(result).toStrictEqual(true)
                    })
                })
            })

            const remoteUser: RemoteUser = {
                name: 'user',
                real_groups: ['org'],
                groups: []
            }

            const pkgAccess = {
                name: 'package'
            }

            describe('allow_access', () => {
                it('calls the callback on error', done => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'packagePermissionsForUserForPackage').mockImplementation(() => {
                        return Promise.reject(new Error('Some error'))
                    })

                    plugin.allow_access(remoteUser, pkgAccess, (err, hasPermission) => {
                        expect(err).not.toBeNull()
                        expect(hasPermission).toBe(false)
                        done()
                    })
                })

                it('calls the callback with true if the user has read permission', done => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'packagePermissionsForUserForPackage').mockImplementation(() => {
                        return Promise.resolve(new Set([readPermission]))
                    })

                    plugin.allow_access(remoteUser, pkgAccess, (err, hasPermission) => {
                        expect(err).toBeNull()
                        expect(hasPermission).toBe(true)
                        done()
                    })
                })

                it('calls the callback with false if the user does not have the read permission', done => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'packagePermissionsForUserForPackage').mockImplementation(() => {
                        return Promise.resolve(new Set([]))
                    })

                    plugin.allow_access(remoteUser, pkgAccess, (err, hasPermission) => {
                        expect(err).toBeNull()
                        expect(hasPermission).toBe(false)
                        done()
                    })
                })
            })

            describe('allow_publish', () => {
                it('calls the callback on error', done => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'packagePermissionsForUserForPackage').mockImplementation(() => {
                        return Promise.reject(new Error('Some error'))
                    })

                    plugin.allow_publish(remoteUser, pkgAccess, (err, loginState) => {
                        expect(err).not.toBeNull()
                        expect(loginState).toBe(false)
                        done()
                    })
                })

                it('calls the callback with true if the user has write permission', done => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'packagePermissionsForUserForPackage').mockImplementation(() => {
                        return Promise.resolve(new Set([writePermission]))
                    })

                    plugin.allow_publish(remoteUser, pkgAccess, (err, hasPermission) => {
                        expect(err).toBeNull()
                        expect(hasPermission).toBe(true)
                        done()
                    })
                })

                it('calls the callback with false if the user does not have the write permission', done => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'packagePermissionsForUserForPackage').mockImplementation(() => {
                        return Promise.resolve(new Set([]))
                    })

                    plugin.allow_publish(remoteUser, pkgAccess, (err, hasPermission) => {
                        expect(err).toBeNull()
                        expect(hasPermission).toBe(false)
                        done()
                    })
                })
            })

            describe('allow_unpublish', () => {
                it('calls the callback on error', done => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'packagePermissionsForUserForPackage').mockImplementation(() => {
                        return Promise.reject(new Error('Some error'))
                    })

                    plugin.allow_unpublish(remoteUser, pkgAccess, (err, loginState) => {
                        expect(err).not.toBeNull()
                        expect(loginState).toBe(false)
                        done()
                    })
                })

                it('calls the callback with true if the user has write permission', done => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'packagePermissionsForUserForPackage').mockImplementation(() => {
                        return Promise.resolve(new Set([writePermission]))
                    })

                    plugin.allow_unpublish(remoteUser, pkgAccess, (err, hasPermission) => {
                        expect(err).toBeNull()
                        expect(hasPermission).toBe(true)
                        done()
                    })
                })

                it('calls the callback with false if the user does not have the write permission', done => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'packagePermissionsForUserForPackage').mockImplementation(() => {
                        return Promise.resolve(new Set([]))
                    })

                    plugin.allow_unpublish(remoteUser, pkgAccess, (err, hasPermission) => {
                        expect(err).toBeNull()
                        expect(hasPermission).toBe(false)
                        done()
                    })
                })
            })

            describe('packageFiles', () => {
                it('returns a promise of an object mapping repository names to the contents of the package.json', () => {
                    const response: s.GetOrganizationPackageFilesQuery[] = [
                        {
                            organization: {
                                repositories: {
                                    pageInfo: {
                                        hasNextPage: false,
                                        endCursor: null
                                    },
                                    edges: [
                                        {
                                            node: {
                                                name: 'repo_1',
                                                object: {
                                                    __typename: 'Blob',
                                                    text: 'pkg_1_content'
                                                }
                                            }
                                        },
                                        {
                                            node: {
                                                name: 'repo_2',
                                                object: {
                                                    __typename: 'Blob',
                                                    text: 'pkg_2_content'
                                                }
                                            }
                                        }
                                    ]
                                }
                            }
                        }
                    ]

                    mockedClient.getAll.mockImplementation(() => {
                        return Promise.resolve(response)
                    })

                    const expectedOutput = {
                        repo_1: 'pkg_1_content',
                        repo_2: 'pkg_2_content'
                    }

                    return expect(plugin.packageFiles()).resolves.toStrictEqual(expectedOutput)
                })
            })

            describe('getPackageName', () => {
                it('returns the name from a valid package.json', () => {
                    expect(GithubAuthPlugin.getPackageName('{ "name": "pkg" }')).toStrictEqual('pkg')
                })

                it('returns undefined from an invalid package.json', () => {
                    expect(GithubAuthPlugin.getPackageName(' "name": "pkg" ')).toBeUndefined()
                })
            })

            describe('packageNames', () => {
                beforeEach(() => {
                    jest.spyOn(plugin, 'packageFiles').mockResolvedValue({
                        repo_1: '{"name":"pkg_1"}',
                        repo_2: '{"name":"pkg_2"}',
                        repo_3: '"name":"pkg_1"'
                    })
                })

                it('should return the map of valid packages', () => {
                    return expect(plugin.packageNames()).resolves.toStrictEqual({
                        pkg_1: 'repo_1',
                        pkg_2: 'repo_2'
                    })
                })

                it('should only return included repos', () => {
                    plugin.includeRepositories = ['repo_1']
                    return expect(plugin.packageNames()).resolves.toStrictEqual({
                        pkg_1: 'repo_1'
                    })
                })

                it('should not return excluded repos', () => {
                    plugin.excludeRepositories = ['repo_1']
                    return expect(plugin.packageNames()).resolves.toStrictEqual({
                        pkg_2: 'repo_2'
                    })
                })

                it('should only return repos matching the regex', () => {
                    plugin.repositoryPattern = /_1$/
                    return expect(plugin.packageNames()).resolves.toStrictEqual({
                        pkg_1: 'repo_1'
                    })
                })
            })

            describe('packagePermissionsForUserForPackage', () => {
                beforeEach(() => {
                    jest.spyOn(plugin, 'packagePermissionsForUser').mockResolvedValue({
                        pkg_1: new Set([readPermission]),
                        pkg_2: new Set([writePermission])
                    })
                })

                const testUser: RemoteUser = {
                    name: 'user',
                    groups: [],
                    real_groups: []
                }

                it('should return an empty set for unknown packages', () => {
                    return expect(plugin.packagePermissionsForUserForPackage(testUser, 'pkg_3')).resolves.toStrictEqual(new Set())
                })

                it('should return the permissions for valid packages', () => {
                    return expect(plugin.packagePermissionsForUserForPackage(testUser, 'pkg_1')).resolves.toStrictEqual(
                        new Set([readPermission])
                    )
                })
            })

            describe('packagePermissionsForUser', () => {
                let remoteUser: RemoteUser

                beforeEach(() => {
                    jest.spyOn(plugin, 'packageNames').mockResolvedValue({
                        pkg_1: 'repo_1',
                        pkg_2: 'repo_2'
                    })

                    jest.spyOn(plugin, 'repositoryPermissions').mockResolvedValue({
                        repo_1: {
                            users: {
                                user: new Set([readPermission])
                            },
                            teams: {}
                        },
                        repo_2: {
                            users: {},
                            teams: {
                                team_1: new Set([readPermission]),
                                team_2: new Set([writePermission])
                            }
                        }
                    })

                    remoteUser = {
                        name: 'user',
                        real_groups: [],
                        groups: []
                    }
                })

                it('should return an empty set for an unknown user', () => {
                    remoteUser.name = 'unknown_user'
                    return expect(plugin.packagePermissionsForUser(remoteUser)).resolves.toStrictEqual({})
                })

                it('should return the user permissions for a user', () => {
                    return expect(plugin.packagePermissionsForUser(remoteUser)).resolves.toStrictEqual({
                        pkg_1: new Set([readPermission])
                    })
                })

                it("should return the union of permissions for a user's teams", () => {
                    remoteUser.name = 'other_user'
                    remoteUser.real_groups = ['team_1', 'team_2']
                    return expect(plugin.packagePermissionsForUser(remoteUser)).resolves.toStrictEqual({
                        pkg_2: new Set([readPermission, writePermission])
                    })
                })
            })

            describe('repositoryPermissions', () => {
                it('should return the direct permissions for users', () => {
                    const response: s.GetOrganizationRepositoryPermissionsQuery[] = [
                        {
                            organization: {
                                repositories: {
                                    pageInfo: {
                                        hasNextPage: false,
                                        endCursor: null
                                    },
                                    edges: [
                                        {
                                            node: {
                                                name: 'repo_1',
                                                collaborators: {
                                                    edges: [
                                                        {
                                                            node: {
                                                                login: 'user_1'
                                                            },
                                                            permissionSources: [
                                                                {
                                                                    permission: s.DefaultRepositoryPermissionField.Admin,
                                                                    source: {
                                                                        __typename: 'Organization',
                                                                        login: 'org'
                                                                    }
                                                                }
                                                            ]
                                                        },
                                                        {
                                                            node: {
                                                                login: 'user_2'
                                                            },
                                                            permissionSources: [
                                                                {
                                                                    permission: s.DefaultRepositoryPermissionField.Read,
                                                                    source: {
                                                                        __typename: 'Organization',
                                                                        login: 'org'
                                                                    }
                                                                }
                                                            ]
                                                        }
                                                    ]
                                                }
                                            }
                                        },
                                        {
                                            node: {
                                                name: 'repo_2',
                                                collaborators: {
                                                    edges: [
                                                        {
                                                            node: {
                                                                login: 'User_1'
                                                            },
                                                            permissionSources: [
                                                                {
                                                                    permission: s.DefaultRepositoryPermissionField.Read,
                                                                    source: {
                                                                        __typename: 'Repository',
                                                                        name: 'repo'
                                                                    }
                                                                }
                                                            ]
                                                        },
                                                        {
                                                            node: {
                                                                login: 'user_2'
                                                            },
                                                            permissionSources: [
                                                                {
                                                                    permission: s.DefaultRepositoryPermissionField.Write,
                                                                    source: {
                                                                        __typename: 'Organization',
                                                                        login: 'org'
                                                                    }
                                                                }
                                                            ]
                                                        }
                                                    ]
                                                }
                                            }
                                        }
                                    ]
                                }
                            }
                        }
                    ]

                    mockedClient.getAll.mockResolvedValue(response)

                    return expect(plugin.repositoryPermissions()).resolves.toStrictEqual({
                        repo_1: {
                            teams: {},
                            users: {
                                user_1: new Set([readPermission, writePermission]),
                                user_2: new Set([readPermission])
                            }
                        },
                        repo_2: {
                            teams: {},
                            users: {
                                user_1: new Set([readPermission]),
                                user_2: new Set([readPermission, writePermission])
                            }
                        }
                    })
                })

                it('should return the permissions for teams', () => {
                    const response: s.GetOrganizationRepositoryPermissionsQuery[] = [
                        {
                            organization: {
                                repositories: {
                                    pageInfo: {
                                        hasNextPage: false,
                                        endCursor: null
                                    },
                                    edges: [
                                        {
                                            node: {
                                                name: 'repo_1',
                                                collaborators: {
                                                    edges: [
                                                        {
                                                            node: {
                                                                login: 'user_1'
                                                            },
                                                            permissionSources: [
                                                                {
                                                                    permission: s.DefaultRepositoryPermissionField.Admin,
                                                                    source: {
                                                                        __typename: 'Team',
                                                                        name: 'team_1'
                                                                    }
                                                                }
                                                            ]
                                                        },
                                                        {
                                                            node: {
                                                                login: 'user_2'
                                                            },
                                                            permissionSources: [
                                                                {
                                                                    permission: s.DefaultRepositoryPermissionField.Read,
                                                                    source: {
                                                                        __typename: 'Team',
                                                                        name: 'team_1'
                                                                    }
                                                                }
                                                            ]
                                                        }
                                                    ]
                                                }
                                            }
                                        },
                                        {
                                            node: {
                                                name: 'repo_2',
                                                collaborators: {
                                                    edges: [
                                                        {
                                                            node: {
                                                                login: 'user_1'
                                                            },
                                                            permissionSources: [
                                                                {
                                                                    permission: s.DefaultRepositoryPermissionField.Read,
                                                                    source: {
                                                                        __typename: 'Team',
                                                                        name: 'team_2'
                                                                    }
                                                                }
                                                            ]
                                                        },
                                                        {
                                                            node: {
                                                                login: 'user_2'
                                                            },
                                                            permissionSources: [
                                                                {
                                                                    permission: s.DefaultRepositoryPermissionField.Read,
                                                                    source: {
                                                                        __typename: 'Team',
                                                                        name: 'team_2'
                                                                    }
                                                                }
                                                            ]
                                                        }
                                                    ]
                                                }
                                            }
                                        }
                                    ]
                                }
                            }
                        }
                    ]

                    mockedClient.getAll.mockResolvedValue(response)

                    return expect(plugin.repositoryPermissions()).resolves.toStrictEqual({
                        repo_1: {
                            teams: {
                                team_1: new Set([readPermission, writePermission])
                            },
                            users: {
                                user_1: new Set([]),
                                user_2: new Set([])
                            }
                        },
                        repo_2: {
                            teams: {
                                team_2: new Set([readPermission])
                            },
                            users: {
                                user_1: new Set([]),
                                user_2: new Set([])
                            }
                        }
                    })
                })
            })
        })
    })
})
