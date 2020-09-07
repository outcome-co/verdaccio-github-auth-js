import GithubAuthPlugin, { AuthenticationError, APIError, setUnion } from './index'
import GraphQLClient from './graphql'
import { expectSetsToBeStrictlyEqual } from '../test/helpers'

jest.mock('./graphql')

const readPermission = 'read'
const writePermission = 'write'

const permissionsMap = {
    ADMIN: new Set([readPermission, writePermission]),
    WRITE: new Set([readPermission, writePermission]),
    READ: new Set([readPermission]),
    NONE: new Set([])
}

class MockHTTPError extends Error {
    constructor (message, status) {
        super(message)
        this.status = status
    }
}

describe('index.js unit tests', () => {
    describe('setUnion', () => {
        it('creates the union of two sets', () => {
            expect([...setUnion(new Set([1, 2]), new Set([1, 2, 3]))].sort()).toStrictEqual([1, 2, 3])
        })
    })

    describe('GithubAuthPlugin', () => {
        /** @type {GithubAuthPlugin} */
        let plugin

        describe('constructor', () => {
            it('should throw an error if no configuration is provided', () => {
                expect(() => {
                    new GithubAuthPlugin() // eslint-disable-line no-new
                }).toThrow('Missing configuration')
            })

            it('should throw an error if no organization is provided', () => {
                expect(() => {
                    plugin = new GithubAuthPlugin({})
                }).toThrow('Missing organization')
            })

            it('should throw an error if no token is provided', () => {
                expect(() => {
                    plugin = new GithubAuthPlugin({
                        organization: 'my-org'
                    })
                }).toThrow('Missing token')
            })
        })

        describe('methods', () => {
            let options

            const config = {
                organization: 'my-org',
                token: 'my-token'
            }

            beforeEach(() => {
                options = {
                    logger: {
                        warn: jest.fn(),
                        trace: jest.fn(),
                        fatal: jest.fn()
                    }
                }

                plugin = new GithubAuthPlugin(config, options)
                GraphQLClient.mockReset()
            })

            describe('mapPermission', () => {
                it.each(Object.keys(permissionsMap))('correctly maps %s', (perm) => {
                    expectSetsToBeStrictlyEqual(plugin.mapPermission(perm), permissionsMap[perm])
                })

                it('raises an error for unknown permissions', () => {
                    expect(() => {
                        plugin.mapPermission(null)
                    }).toThrow(APIError)
                })
            })

            describe('authenticate', () => {
                it('fails on invalid user', (done) => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'verifyUserIdentity').mockRejectedValue(new AuthenticationError('Invalid user', false))

                    plugin.authenticate('user', 'token', (err, groups) => {
                        expect(err).toBeNull()
                        expect(groups).toStrictEqual(false)
                        done()
                    })
                })

                it('fails if user does not belong to the organisation', (done) => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'verifyUserIdentity').mockResolvedValue(true)
                    jest.spyOn(plugin, 'verifyOrganization').mockRejectedValue(new AuthenticationError('Org error', false))

                    plugin.authenticate('user', 'token', (err, groups) => {
                        expect(err).toBeNull()
                        expect(groups).toStrictEqual(false)
                        done()
                    })
                })

                it('fails if there is an error retrieving the teams', (done) => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'verifyUserIdentity').mockResolvedValue(true)
                    jest.spyOn(plugin, 'verifyOrganization').mockResolvedValue(true)
                    jest.spyOn(plugin, 'getUserTeams').mockRejectedValue(new Error('Some error'))

                    plugin.authenticate('user', 'token', (err, groups) => {
                        expect(err).toStrictEqual(true)
                        expect(groups).toBeNull()
                        done()
                    })
                })

                it('fails if there is an internal error', (done) => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'verifyUserIdentity').mockRejectedValue(new Error())

                    plugin.authenticate('user', 'token', (err, groups) => {
                        expect(err).toStrictEqual(true)
                        expect(groups).toBeNull()
                        done()
                    })
                })

                it('succeeds if the user is valid', (done) => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'verifyUserIdentity').mockResolvedValue(true)
                    jest.spyOn(plugin, 'verifyOrganization').mockResolvedValue(true)

                    const teams = ['team']

                    jest.spyOn(plugin, 'getUserTeams').mockResolvedValue(teams)

                    plugin.authenticate('user', 'token', (err, groups) => {
                        expect(err).toBeNull()
                        expect(groups).toStrictEqual(teams)
                        done()
                    })
                })
            })

            describe('verifyUserIdentity', () => {
                it('uses the user token', (done) => {
                    expect.assertions(2)

                    GraphQLClient.mockImplementation(() => {
                        return {
                            get: () => {
                                return Promise.resolve()
                            }
                        }
                    })

                    plugin.verifyUserIdentity('user', 'token').catch(() => true).finally(() => {
                        expect(GraphQLClient).toHaveBeenCalledTimes(1)
                        expect(GraphQLClient).toHaveBeenCalledWith('token', options.logger)
                        done()
                    })
                })

                it('throws an AuthenticationError(loginState=false) if token is invalid', (done) => {
                    expect.assertions(2)
                    const user = 'user'

                    GraphQLClient.mockImplementation(() => {
                        return {
                            get: () => {
                                return Promise.reject(new MockHTTPError('Failed', 401))
                            }
                        }
                    })

                    plugin.verifyUserIdentity(user, 'token').catch((err) => {
                        expect(err instanceof AuthenticationError).toStrictEqual(true)
                        expect(err.loginState).toStrictEqual(false)
                        done()
                    })
                })

                it('throws an internal error if there is a unknown error', (done) => {
                    expect.assertions(2)
                    const user = 'user'

                    GraphQLClient.mockImplementation(() => {
                        return {
                            get: () => {
                                return Promise.reject(new Error('Some error'))
                            }
                        }
                    })

                    plugin.verifyUserIdentity(user, 'token').catch((err) => {
                        expect(err instanceof AuthenticationError).toStrictEqual(true)
                        expect(err.loginState).toBeNull()
                        done()
                    })
                })

                it('returns true if the user matches the token', (done) => {
                    expect.assertions(1)
                    const user = 'user'

                    GraphQLClient.mockImplementation(() => {
                        return {
                            get: () => {
                                return Promise.resolve({
                                    viewer: {
                                        login: user
                                    }
                                })
                            }
                        }
                    })

                    plugin.verifyUserIdentity(user, 'token').then((result) => {
                        expect(result).toStrictEqual(true)
                        done()
                    })
                })

                it('throws an AuthenticationError(loginState=false) if user does not match token', (done) => {
                    expect.assertions(2)
                    const user = 'user'

                    GraphQLClient.mockImplementation(() => {
                        return {
                            get: () => {
                                return Promise.resolve({
                                    viewer: {
                                        login: 'not user'
                                    }
                                })
                            }
                        }
                    })

                    plugin.verifyUserIdentity(user, 'token').catch((err) => {
                        expect(err instanceof AuthenticationError).toStrictEqual(true)
                        expect(err.loginState).toStrictEqual(false)
                        done()
                    })
                })
            })

            describe('getUserTeams', () => {
                it('returns the members team for a non admin user', (done) => {
                    expect.assertions(1)
                    const user = 'user'
                    const userTeam = 'members'
                    const notUserTeam = 'admins'

                    GraphQLClient.mockReset()
                    GraphQLClient.mockImplementation(() => {
                        return {
                            getAll: () => {
                                return Promise.resolve({
                                    organization: {
                                        teams: {
                                            edges: [
                                                {
                                                    node: {
                                                        name: userTeam,
                                                        members: {
                                                            nodes: [
                                                                {
                                                                    login: user
                                                                }
                                                            ]
                                                        }
                                                    }
                                                },
                                                {
                                                    node: {
                                                        name: notUserTeam,
                                                        members: {
                                                            nodes: [
                                                            ]
                                                        }
                                                    }
                                                }
                                            ]
                                        }
                                    }
                                })
                            }
                        }
                    })

                    // We have to do this here to ensure we're using the
                    // local GraphQL mock
                    plugin = new GithubAuthPlugin(config, options)

                    plugin.getUserTeams(user).then((result) => {
                        expect(result).toStrictEqual([config.organization, userTeam])
                        done()
                    })
                })
            })

            describe('verifyOrganization', () => {
                it('throws an AuthenticationError(loginState=false) if user is not in organization', (done) => {
                    expect.assertions(2)
                    const user = 'user'

                    GraphQLClient.mockImplementation(() => {
                        return {
                            getAll: () => {
                                return Promise.resolve({
                                    organization: {
                                        membersWithRole: {
                                            edges: [
                                                {
                                                    node: {
                                                        login: 'some_user'
                                                    }
                                                }
                                            ]
                                        }
                                    }
                                })
                            }
                        }
                    })

                    // We have to do this here to ensure we're using the
                    // local GraphQL mock
                    plugin = new GithubAuthPlugin(config, options)

                    plugin.verifyOrganization(user).catch((err) => {
                        expect(err instanceof AuthenticationError).toStrictEqual(true)
                        expect(err.loginState).toStrictEqual(false)
                        done()
                    })
                })

                it('returns true if user is in organization', (done) => {
                    expect.assertions(1)
                    const user = 'user'

                    GraphQLClient.mockImplementation(() => {
                        return {
                            getAll: () => {
                                return Promise.resolve({
                                    organization: {
                                        membersWithRole: {
                                            edges: [
                                                {
                                                    node: {
                                                        login: user
                                                    }
                                                }
                                            ]
                                        }
                                    }
                                })
                            }
                        }
                    })

                    // We have to do this here to ensure we're using the
                    // local GraphQL mock
                    plugin = new GithubAuthPlugin(config, options)

                    plugin.verifyOrganization(user).then((result) => {
                        expect(result).toStrictEqual(true)
                        done()
                    })
                })
            })

            const remoteUser = {
                name: 'user',
                real_groups: ['org']
            }

            const pkgAccess = {
                name: 'package'
            }

            describe('allow_access', () => {
                it('calls the callback on error', (done) => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'packagePermissionsForUserForPackage').mockImplementation(() => {
                        return Promise.reject(new Error('Some error'))
                    })

                    plugin.allow_access(remoteUser, pkgAccess, (err, hasPermission) => {
                        expect(err).not.toBeNull()
                        expect(hasPermission).toBeUndefined()
                        done()
                    })
                })

                it('calls the callback with true if the user has read permission', (done) => {
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

                it('calls the callback with false if the user does not have the read permission', (done) => {
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
                it('calls the callback on error', (done) => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'packagePermissionsForUserForPackage').mockImplementation(() => {
                        return Promise.reject(new Error('Some error'))
                    })

                    plugin.allow_publish(remoteUser, pkgAccess, (err, loginState) => {
                        expect(err).not.toBeNull()
                        expect(loginState).toBeUndefined()
                        done()
                    })
                })

                it('calls the callback with true if the user has write permission', (done) => {
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

                it('calls the callback with false if the user does not have the write permission', (done) => {
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
                it('calls the callback on error', (done) => {
                    expect.assertions(2)

                    jest.spyOn(plugin, 'packagePermissionsForUserForPackage').mockImplementation(() => {
                        return Promise.reject(new Error('Some error'))
                    })

                    plugin.allow_unpublish(remoteUser, pkgAccess, (err, loginState) => {
                        expect(err).not.toBeNull()
                        expect(loginState).toBeUndefined()
                        done()
                    })
                })

                it('calls the callback with true if the user has write permission', (done) => {
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

                it('calls the callback with false if the user does not have the write permission', (done) => {
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
                    plugin.client.getAll.mockImplementation(() => {
                        return Promise.resolve({
                            organization: {
                                repositories: {
                                    edges: [
                                        {
                                            node: {
                                                name: 'repo_1',
                                                object: {
                                                    text: 'pkg_1_content'
                                                }
                                            }
                                        },
                                        {
                                            node: {
                                                name: 'repo_2',
                                                object: {
                                                    text: 'pkg_2_content'
                                                }
                                            }
                                        }
                                    ]
                                }
                            }
                        })
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
                    jest.spyOn(plugin, 'packageFiles').mockResolvedValue(({
                        repo_1: '{"name":"pkg_1"}',
                        repo_2: '{"name":"pkg_2"}',
                        repo_3: '"name":"pkg_1"',
                        repo_4: null
                    }))
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
                    plugin.repositoryPattern = '_1$'
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

                it('should return an empty set for unknown packages', () => {
                    return expect(plugin.packagePermissionsForUserForPackage('user', 'pkg_3')).resolves.toStrictEqual(new Set())
                })

                it('should return the permissions for valid packages', () => {
                    return expect(plugin.packagePermissionsForUserForPackage('user', 'pkg_1')).resolves.toStrictEqual(new Set([readPermission]))
                })
            })

            describe('packagePermissionsForUser', () => {
                let remoteUser

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
                        real_groups: []
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

                it('should return the union of permissions for a user\'s teams', () => {
                    remoteUser.name = 'other_user'
                    remoteUser.real_groups = ['team_1', 'team_2']
                    return expect(plugin.packagePermissionsForUser(remoteUser)).resolves.toStrictEqual({
                        pkg_2: new Set([readPermission, writePermission])
                    })
                })
            })

            describe('repositoryPermissions', () => {
                it('should return the direct permissions for users', () => {
                    plugin.client.getAll.mockResolvedValue({
                        organization: {
                            repositories: {
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
                                                                permission: 'ADMIN',
                                                                source: {
                                                                    __typename: 'Organization'
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
                                                                permission: 'READ',
                                                                source: {
                                                                    __typename: 'Organization'
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
                                                                permission: 'READ',
                                                                source: {
                                                                    __typename: 'Repository'
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
                                                                permission: 'WRITE',
                                                                source: {
                                                                    __typename: 'Organization'
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
                    })

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
                    plugin.client.getAll.mockResolvedValue({
                        organization: {
                            repositories: {
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
                                                                permission: 'ADMIN',
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
                                                                permission: 'READ',
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
                                                                permission: 'READ',
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
                                                                permission: 'READ',
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
                    })

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
