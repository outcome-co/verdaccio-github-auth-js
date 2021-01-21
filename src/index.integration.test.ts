import GithubAuthPlugin, { AuthenticationError } from './index'
import { skipAllForUnit } from '@outcome-co/devkit/dist/utils/skipIf'
import GithubScenario from './test/github'
import { every, keys, pickBy, has, forOwn, first, reduce, includes, map, filter, isEqual } from 'lodash'
import { token, org, userMap, memberUsername, memberToken, nonMemberUsername } from './test/env'
import { rateLimiter } from './test/rateLimiting'
import { GithubAuthPluginConfig, GithubAuthPluginOptions } from './index'
import { Logger, RemoteUser, PackageAccess, AuthAccessCallback, AllowAccess } from '@verdaccio/types'
import { RepositoryPermission } from './schemaTypes'

jest.setTimeout(30000)

/**
 * Load the scenario at the given path.
 *
 * @param name - The path to the JSON scenario.
 * @returns - A GithubScenario instance.
 */
function withScenario(name: string): Promise<GithubScenario> {
    return GithubScenario.load(token, org, name, userMap)
}

const config: GithubAuthPluginConfig = {
    organization: org,
    token,
    rateLimiter
}

const readWrite: RepositoryPermission[] = [RepositoryPermission.Admin, RepositoryPermission.Write, RepositoryPermission.Maintain]
const readOnly: RepositoryPermission[] = [RepositoryPermission.Read, RepositoryPermission.Triage]

const options: GithubAuthPluginOptions = <GithubAuthPluginOptions>{
    logger: <Logger>(<unknown>{
        warn: jest.fn(),
        trace: jest.fn(),
        error: jest.fn()
    }),
    config
}

// In our tests, we remove the possible void type of the name
type TestRemoteUser = Omit<RemoteUser, 'name'> & { name: string }

describe('index.js integration tests', () => {
    skipAllForUnit('GithubAuthPlugin', () => {
        let plugin: GithubAuthPlugin
        let scenario: GithubScenario

        beforeEach(() => {
            plugin = new GithubAuthPlugin(config, options)
        })

        describe('caching', () => {
            const remoteUser: TestRemoteUser = {
                name: 'user',
                real_groups: <string[]>[],
                groups: <string[]>[]
            }

            it('packageFiles should be cached', () => {
                const spy = jest.spyOn(plugin.client, 'getAll')

                expect.assertions(1)

                return plugin
                    .packageFiles()
                    .then(() => {
                        return plugin.packageFiles()
                    })
                    .then(() => {
                        expect(spy).toHaveBeenCalledTimes(1)
                    })
            })

            it('packageNames should be cached', () => {
                const spy = jest.spyOn(plugin, 'packageFiles')

                expect.assertions(1)

                return plugin
                    .packageNames()
                    .then(() => {
                        return plugin.packageNames()
                    })
                    .then(() => {
                        expect(spy).toHaveBeenCalledTimes(1)
                    })
            })

            it('repositoryPermissions should be cached', () => {
                const spy = jest.spyOn(plugin, 'packageNames')

                expect.assertions(1)

                return plugin
                    .packagePermissionsForUser(remoteUser)
                    .then(() => {
                        return plugin.packagePermissionsForUser(remoteUser)
                    })
                    .then(() => {
                        expect(spy).toHaveBeenCalledTimes(1)
                    })
            })

            it('packagePermissionsForUser should be cached', () => {
                const spy = jest.spyOn(plugin, 'repositoryPermissions')

                expect.assertions(1)

                return plugin
                    .packagePermissionsForUser(remoteUser)
                    .then(() => {
                        return plugin.packagePermissionsForUser(remoteUser)
                    })
                    .then(() => {
                        expect(spy).toHaveBeenCalledTimes(1)
                    })
            })
        })

        describe('methods', () => {
            describe('verifyOrganization', () => {
                it('should verify a valid user/org', () => {
                    expect.assertions(1)

                    return plugin.verifyOrganization(memberUsername).then(result => {
                        expect(result).toBe(true)
                    })
                })

                it('should throw an error for an invalid user/org', () => {
                    expect.assertions(1)

                    return plugin.verifyOrganization(nonMemberUsername).catch(err => {
                        expect(err instanceof AuthenticationError).toBe(true)
                    })
                })
            })

            describe('verifyUserIdentity', () => {
                it('should verify a valid user', () => {
                    return expect(plugin.verifyUserIdentity(memberUsername, memberToken)).resolves.toBeUndefined()
                })

                it('should throw an error for an invalid token', () => {
                    return expect(plugin.verifyUserIdentity(memberUsername, 'bad token')).rejects.toThrow(AuthenticationError)
                })

                it('should throw an error for a mismatched token', () => {
                    return expect(plugin.verifyUserIdentity(memberUsername, token)).rejects.toThrow(AuthenticationError)
                })
            })

            describe('authenticate', () => {
                beforeAll(() => {
                    // Returning a promise here
                    // Jest knows how to handle it
                    return withScenario('multiple_teams').then(sc => {
                        scenario = sc
                        return scenario.up()
                    })
                })

                afterAll(() => {
                    return scenario.down()
                })

                it('returns the org and the correct teams', () => {
                    expect.assertions(2)

                    const expectedTeams = reduce(
                        scenario.scenario.teams,
                        (teams, team) => {
                            if (includes(team.members, memberUsername)) {
                                teams.push(team.name)
                            }
                            return teams
                        },
                        <string[]>[]
                    )

                    return new Promise<false | string[]>((resolve, reject) => {
                        plugin.authenticate(memberUsername, memberToken, (err, teams) => {
                            if (err) {
                                reject(err)
                            } else {
                                resolve(teams)
                            }
                        })
                    }).then(teams => {
                        expect(teams).toContain(org)
                        // If the test above doesn't fail, teams is a string[]
                        teams = <string[]>teams
                        const filteredTeams = filter(teams, t => t.endsWith(scenario.sessionId))
                        expect(isEqual(filteredTeams, expectedTeams)).toBe(true)
                    })
                })
            })

            describe('packageNames', () => {
                it('should return the names of all packages, and the associated repo', () => {
                    expect.assertions(1)

                    return withScenario('packages').then(sc =>
                        sc.run(scenario => {
                            const scenarioPackages = scenario.packages()

                            return plugin.packageNames().then(packages => {
                                expect(
                                    every(scenarioPackages, (repoName, packageName) => packages[packageName] === repoName)
                                ).toBe(true)
                            })
                        })
                    )
                })

                it('should only include packages from the included repos', () => {
                    expect.assertions(4)

                    return withScenario('packages').then(sc =>
                        sc.run(scenario => {
                            const scenarioPackages = scenario.packages()
                            const includedPackage = keys(scenarioPackages)[0]

                            const includedPackageWithRepo = pickBy(scenarioPackages, (_v, k) => k === includedPackage)
                            const excludedPackagesWithRepos = pickBy(scenarioPackages, (_v, k) => k !== includedPackage)

                            expect(keys(includedPackageWithRepo).length).toBeGreaterThan(0)
                            expect(keys(excludedPackagesWithRepos).length).toBeGreaterThan(0)

                            plugin.includeRepositories = [includedPackageWithRepo[includedPackage]]

                            return plugin.packageNames().then(packages => {
                                expect(
                                    every(includedPackageWithRepo, (repoName, packageName) => packages[packageName] === repoName)
                                ).toBe(true)
                                expect(
                                    every(excludedPackagesWithRepos, (_repoName, packageName) => !has(packages, packageName))
                                ).toBe(true)
                            })
                        })
                    )
                })

                it('should only include packages that are not excluded', () => {
                    expect.assertions(4)

                    return withScenario('packages').then(sc =>
                        sc.run(scenario => {
                            const scenarioPackages = scenario.packages()
                            const excludedPackage = keys(scenarioPackages)[0]

                            const includedPackagesWithRepo = pickBy(scenarioPackages, (_v, k) => k !== excludedPackage)
                            const excludedPackageWithRepos = pickBy(scenarioPackages, (_v, k) => k === excludedPackage)

                            expect(keys(includedPackagesWithRepo).length).toBeGreaterThan(0)
                            expect(keys(excludedPackageWithRepos).length).toBeGreaterThan(0)

                            plugin.excludeRepositories = [excludedPackageWithRepos[excludedPackage]]

                            return plugin.packageNames().then(packages => {
                                expect(
                                    every(includedPackagesWithRepo, (repoName, packageName) => packages[packageName] === repoName)
                                ).toBe(true)
                                expect(
                                    every(excludedPackageWithRepos, (_repoName, packageName) => !has(packages, packageName))
                                ).toBe(true)
                            })
                        })
                    )
                })

                it('should only include packages that match the pattern', () => {
                    expect.assertions(4)

                    return withScenario('packages').then(sc =>
                        sc.run(scenario => {
                            const pattern = /^package_repository_1/
                            const compiled = RegExp(pattern)
                            const scenarioPackages = scenario.packages()

                            const includedPackagesWithRepo = pickBy(scenarioPackages, v => compiled.test(v))
                            const excludedPackagesWithRepos = pickBy(scenarioPackages, v => !compiled.test(v))

                            expect(keys(includedPackagesWithRepo).length).toBeGreaterThan(0)
                            expect(keys(excludedPackagesWithRepos).length).toBeGreaterThan(0)

                            plugin.repositoryPattern = pattern

                            return plugin.packageNames().then(packages => {
                                expect(
                                    every(includedPackagesWithRepo, (repoName, packageName) => packages[packageName] === repoName)
                                ).toBe(true)
                                expect(
                                    every(excludedPackagesWithRepos, (_repoName, packageName) => !has(packages, packageName))
                                ).toBe(true)
                            })
                        })
                    )
                })
            })

            describe('allow_access/publish/unpublish', () => {
                const remoteUser: TestRemoteUser = {
                    name: memberUsername,
                    real_groups: <string[]>[],
                    groups: <string[]>[]
                }

                describe('with user permissions', () => {
                    // Here we use the beforeAll/afterAll to
                    // setup/teardown the scenario once, for
                    // all the tests
                    beforeAll(() => {
                        return withScenario('user_permissions').then(sc => {
                            scenario = sc
                            return scenario.up()
                        })
                    })

                    afterAll(() => scenario.down())

                    describe.each(readWrite)('has write/read permissions for %s', role => {
                        // eslint-disable-next-line jest/expect-expect
                        it('can publish', () => {
                            return hasUserRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_publish(remoteUser, pkgAccess, cb)
                            })
                        })

                        // eslint-disable-next-line jest/expect-expect
                        it('can unpublish', () => {
                            return hasUserRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_unpublish(remoteUser, pkgAccess, cb)
                            })
                        })

                        // eslint-disable-next-line jest/expect-expect
                        it('can access', () => {
                            return hasUserRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_access(remoteUser, pkgAccess, cb)
                            })
                        })
                    })

                    describe.each(readOnly)('has read-only permissions for %s', role => {
                        // eslint-disable-next-line jest/expect-expect
                        it('cannot publish', () => {
                            return doesNotHaveUserRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_publish(remoteUser, pkgAccess, cb)
                            })
                        })

                        // eslint-disable-next-line jest/expect-expect
                        it('cannot unpublish', () => {
                            return doesNotHaveUserRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_unpublish(remoteUser, pkgAccess, cb)
                            })
                        })

                        // eslint-disable-next-line jest/no-identical-title, jest/expect-expect
                        it('can access', () => {
                            return hasUserRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_access(remoteUser, pkgAccess, cb)
                            })
                        })
                    })

                    it('does not allow access to unauthorized packages', () => {
                        let pkg = first(Object.keys(scenario.scenario.packagesWithNoCollaborators()))

                        expect.assertions(2)
                        expect(pkg).toBeDefined()

                        // We know pkg is defined
                        pkg = <string>pkg

                        return plugin.packagePermissionsForUserForPackage(remoteUser, pkg).then(packagePermissions => {
                            expect([...packagePermissions]).toStrictEqual([])
                        })
                    })
                })

                describe('with team permissions', () => {
                    // Here we use the beforeAll/afterAll to
                    // setup/teardown the scenario once, for
                    // all the tests
                    beforeAll(() => {
                        return withScenario('team_permissions').then(sc => {
                            scenario = sc
                            remoteUser.real_groups = map(scenario.scenario.teamsForUser(remoteUser.name), t => t.name)
                            return scenario.up()
                        })
                    })

                    afterAll(() => {
                        remoteUser.real_groups = []
                        return scenario.down()
                    })

                    describe.each(readWrite)('has write/read permissions for %s', role => {
                        // eslint-disable-next-line jest/expect-expect
                        it('can publish', () => {
                            return hasTeamRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_publish(remoteUser, pkgAccess, cb)
                            })
                        })

                        // eslint-disable-next-line jest/expect-expect
                        it('can unpublish', () => {
                            return hasTeamRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_unpublish(remoteUser, pkgAccess, cb)
                            })
                        })

                        // eslint-disable-next-line jest/expect-expect
                        it('can access', () => {
                            return hasTeamRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_access(remoteUser, pkgAccess, cb)
                            })
                        })
                    })

                    describe.each(readOnly)('has read-only permissions for %s', role => {
                        // eslint-disable-next-line jest/expect-expect
                        it('cannot publish', () => {
                            return doesNotHaveTeamRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_publish(remoteUser, pkgAccess, cb)
                            })
                        })

                        // eslint-disable-next-line jest/expect-expect
                        it('cannot unpublish', () => {
                            return doesNotHaveTeamRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_unpublish(remoteUser, pkgAccess, cb)
                            })
                        })

                        // eslint-disable-next-line jest/no-identical-title, jest/expect-expect
                        it('can access', () => {
                            return hasTeamRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_access(remoteUser, pkgAccess, cb)
                            })
                        })
                    })
                })
            })
        })
    })
})

type CheckFn = (pkg: PackageAccess & AllowAccess, cb: AuthAccessCallback) => void

/**
 * Checks that the user has the role.
 *
 * @param scenario - The scenario.
 * @param remoteUser - The user.
 * @param role - The Github role.
 * @param checkFn - The check callback.
 * @returns A promise on the array of checks.
 */
const hasUserRole = (
    scenario: GithubScenario,
    remoteUser: TestRemoteUser,
    role: RepositoryPermission,
    checkFn: CheckFn
): Promise<void> => {
    return userRoleCheck(scenario, remoteUser, role, true, checkFn)
}

/**
 * Checks that the user doesn't have the role.
 *
 * @param scenario - The scenario.
 * @param remoteUser - The user.
 * @param role - The Github role.
 * @param checkFn - The check callback.
 * @returns A promise on the array of checks.
 */
const doesNotHaveUserRole = (
    scenario: GithubScenario,
    remoteUser: TestRemoteUser,
    role: RepositoryPermission,
    checkFn: CheckFn
): Promise<void> => {
    return userRoleCheck(scenario, remoteUser, role, false, checkFn)
}

/**
 * A test helper for checking user permissions.
 *
 * @param scenario - The scenario.
 * @param remoteUser - The user.
 * @param role - The Github role.
 * @param hasPermission - Whether to check if the user has the permission, or doesn't have the permission.
 * @param checkFn - The check callback.
 * @returns A promise on the array of checks.
 */
const userRoleCheck = (
    scenario: GithubScenario,
    remoteUser: TestRemoteUser,
    role: RepositoryPermission,
    hasPermission: boolean,
    checkFn: CheckFn
): Promise<void> => {
    const packages = scenario.scenario.packagesForUserRole(remoteUser.name, role)
    return roleCheck(packages, hasPermission, checkFn)
}

/**
 * Checks that the user has the role via teams.
 *
 * @param scenario - The scenario.
 * @param remoteUser - The user.
 * @param role - The Github role.
 * @param checkFn - The check callback.
 * @returns A promise on the array of checks.
 */
const hasTeamRole = (
    scenario: GithubScenario,
    remoteUser: TestRemoteUser,
    role: RepositoryPermission,
    checkFn: CheckFn
): Promise<void> => {
    return teamRoleCheck(scenario, remoteUser, role, true, checkFn)
}

/**
 * Checks that the user doesn't have the role via teams.
 *
 * @param scenario - The scenario.
 * @param remoteUser - The user.
 * @param role - The Github role.
 * @param checkFn - The check callback.
 * @returns A promise on the array of checks.
 */
const doesNotHaveTeamRole = (
    scenario: GithubScenario,
    remoteUser: TestRemoteUser,
    role: RepositoryPermission,
    checkFn: CheckFn
): Promise<void> => {
    return teamRoleCheck(scenario, remoteUser, role, false, checkFn)
}

/**
 * A test helper for checking user permissions via teams.
 *
 * @param scenario - The scenario.
 * @param remoteUser - The user.
 * @param role - The Github role.
 * @param hasPermission - Whether to check if the user has the permission, or doesn't have the permission.
 * @param checkFn - The check callback.
 * @returns A promise on the array of checks.
 */
const teamRoleCheck = (
    scenario: GithubScenario,
    remoteUser: TestRemoteUser,
    role: RepositoryPermission,
    hasPermission: boolean,
    checkFn: CheckFn
): Promise<void> => {
    const packages = scenario.scenario.packagesForUserTeamRole(remoteUser.name, role)
    return roleCheck(packages, hasPermission, checkFn)
}

/**
 * A test helper for checking permissions.
 *
 * @param packages - The packages.
 * @param hasPermission - Whether to check if the user has the permission, or doesn't have the permission.
 * @param checkFn - The check callback.
 * @returns A promise on the array of checks.
 */
const roleCheck = (packages: Record<string, string>, hasPermission: boolean, checkFn: CheckFn): Promise<void> => {
    // For each package, we're going to run a check
    // Plus the initial toBeGreaterThan check
    expect.assertions(Object.keys(packages).length + 1)
    expect(Object.keys(packages).length).toBeGreaterThan(0)

    let check
    const checks: Promise<void>[] = []

    forOwn(packages, (_repository, pkg) => {
        const pkgAccess: PackageAccess & AllowAccess = {
            name: pkg
        }

        // We have to wrap the callback in a promise
        check = new Promise((resolve, reject) => {
            checkFn(pkgAccess, (err, result) => {
                if (err) {
                    reject(err)
                } else {
                    resolve(result)
                }
            })
        }).then(result => {
            expect(result).toBe(hasPermission)
        })
        checks.push(check)
    })

    return Promise.all(checks).then(() => Promise.resolve())
}
