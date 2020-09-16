import GithubAuthPlugin, { AuthenticationError } from './index'
import { skipAllForUnit } from '@outcome-co/devkit/dist/utils/skipIf'
import GithubScenario from '../test/github'
import { every, keys, pickBy, has, forOwn, first, reduce, includes, map, filter, isEqual } from 'lodash'
import { token, org, userMap, memberUsername, memberToken, nonMemberUsername } from '../test/env'
import { rateLimiter } from '../test/rateLimiting'

const it = require('jest-retries')
const retries = 3

jest.setTimeout(30000)

/**
 * Load the scenario at the given path.
 *
 * @param {string} path - The path to the JSON scenario.
 * @returns {GithubScenario} - A GithubScenario instance.
 */
function withScenario (path) {
    return new GithubScenario(token, org, path, userMap)
}

/**
 * @typedef {('admin'|'maintain'|'push'|'triage'|'pull')} GithubRESTRepoPermissions
 * @typedef {import('./index').PackagePermission} PackagePermission
 */

const config = {
    organization: org,
    token,
    rateLimiter
}

const options = {
    logger: {
        warn: jest.fn(),
        trace: jest.fn(),
        fatal: jest.fn()
    }
}

describe('index.js integration tests', () => {
    skipAllForUnit('GithubAuthPlugin', () => {
        /** @type {GithubAuthPlugin} */
        let plugin

        /** @type {GithubScenario} */
        let scenario

        beforeEach(() => {
            plugin = new GithubAuthPlugin(config, options)
        })

        describe('caching', () => {
            const remoteUser = {
                name: 'user',
                real_groups: []
            }

            it('packageFiles should be cached', () => {
                const spy = jest.spyOn(plugin.client, 'getAll')

                expect.assertions(1)

                return plugin.packageFiles().then(() => {
                    return plugin.packageFiles()
                }).then(() => {
                    expect(spy).toHaveBeenCalledTimes(1)
                })
            })

            it('packageNames should be cached', () => {
                const spy = jest.spyOn(plugin, 'packageFiles')

                expect.assertions(1)

                return plugin.packageNames().then(() => {
                    return plugin.packageNames()
                }).then(() => {
                    expect(spy).toHaveBeenCalledTimes(1)
                })
            })

            it('repositoryPermissions should be cached', () => {
                const spy = jest.spyOn(plugin, 'packageNames')

                expect.assertions(1)

                return plugin.packagePermissionsForUser(remoteUser).then(() => {
                    return plugin.packagePermissionsForUser(remoteUser)
                }).then(() => {
                    expect(spy).toHaveBeenCalledTimes(1)
                })
            })

            it('packagePermissionsForUser should be cached', () => {
                const spy = jest.spyOn(plugin, 'repositoryPermissions')

                expect.assertions(1)

                return plugin.packagePermissionsForUser(remoteUser).then(() => {
                    return plugin.packagePermissionsForUser(remoteUser)
                }).then(() => {
                    expect(spy).toHaveBeenCalledTimes(1)
                })
            })
        })

        describe('methods', () => {
            describe('verifyOrganization', () => {
                it('should verify a valid user/org', retries, () => {
                    expect.assertions(1)

                    return plugin.verifyOrganization(memberUsername).then((result) => {
                        expect(result).toBe(true)
                    })
                })

                it('should throw an error for an invalid user/org', retries, () => {
                    expect.assertions(1)

                    return plugin.verifyOrganization(nonMemberUsername).catch((err) => {
                        expect(err instanceof AuthenticationError).toBe(true)
                    })
                })
            })

            describe('verifyUserIdentity', () => {
                it('should verify a valid user', retries, () => {
                    expect.assertions(1)

                    return plugin.verifyUserIdentity(memberUsername, memberToken).then((result) => {
                        expect(result).toBe(true)
                    })
                })

                it('should throw an error for an invalid token', retries, () => {
                    expect.assertions(1)

                    return plugin.verifyUserIdentity(memberUsername, 'bad token').catch((err) => {
                        expect(err instanceof AuthenticationError).toBe(true)
                    })
                })

                it('should throw an error for a mismatched token', retries, () => {
                    expect.assertions(1)

                    return plugin.verifyUserIdentity(memberUsername, token).catch((err) => {
                        expect(err instanceof AuthenticationError).toBe(true)
                    })
                })
            })

            describe('authenticate', () => {
                beforeAll(() => {
                    scenario = withScenario('multiple_teams')

                    // Returning a promise here
                    // Jest knows how to handle it
                    return scenario.up()
                })

                afterAll(() => {
                    return scenario.down()
                })

                it('returns the org and the correct teams', retries, () => {
                    expect.assertions(2)

                    const expectedTeams = reduce(scenario.scenario.teams, (teams, team) => {
                        if (includes(team.members, memberUsername)) {
                            teams.push(team.name)
                        }
                        return teams
                    }, [])

                    return new Promise((resolve, reject) => {
                        plugin.authenticate(memberUsername, memberToken, (err, teams) => {
                            if (err) {
                                reject(err)
                            } else {
                                resolve(teams)
                            }
                        })
                    }).then((teams) => {
                        expect(teams).toContain(org)
                        const filteredTeams = filter(teams, t => t.endsWith(scenario.sessionId))
                        expect(isEqual(filteredTeams, expectedTeams)).toBe(true)
                    })
                })
            })

            describe('packageNames', () => {
                it('should return the names of all packages, and the associated repo', retries, () => {
                    expect.assertions(1)

                    return withScenario('packages').run((scenario) => {
                        const scenarioPackages = scenario.packages()

                        return plugin.packageNames().then((packages) => {
                            expect(every(scenarioPackages, (repoName, packageName) => packages[packageName] === repoName)).toBe(true)
                        })
                    })
                })

                it('should only include packages from the included repos', retries, () => {
                    expect.assertions(4)

                    return withScenario('packages').run((scenario) => {
                        const scenarioPackages = scenario.packages()
                        const includedPackage = keys(scenarioPackages)[0]

                        const includedPackageWithRepo = pickBy(scenarioPackages, (v, k) => k === includedPackage)
                        const excludedPackagesWithRepos = pickBy(scenarioPackages, (v, k) => k !== includedPackage)

                        expect(keys(includedPackageWithRepo).length).toBeGreaterThan(0)
                        expect(keys(excludedPackagesWithRepos).length).toBeGreaterThan(0)

                        plugin.includeRepositories = [includedPackageWithRepo[includedPackage]]

                        return plugin.packageNames().then((packages) => {
                            expect(every(includedPackageWithRepo, (repoName, packageName) => packages[packageName] === repoName)).toBe(true)
                            expect(every(excludedPackagesWithRepos, (repoName, packageName) => !has(packages, packageName))).toBe(true)
                        })
                    })
                })

                it('should only include packages that are not excluded', retries, () => {
                    expect.assertions(4)

                    return withScenario('packages').run((scenario) => {
                        const scenarioPackages = scenario.packages()
                        const excludedPackage = keys(scenarioPackages)[0]

                        const includedPackagesWithRepo = pickBy(scenarioPackages, (v, k) => k !== excludedPackage)
                        const excludedPackageWithRepos = pickBy(scenarioPackages, (v, k) => k === excludedPackage)

                        expect(keys(includedPackagesWithRepo).length).toBeGreaterThan(0)
                        expect(keys(excludedPackageWithRepos).length).toBeGreaterThan(0)

                        plugin.excludeRepositories = [excludedPackageWithRepos[excludedPackage]]

                        return plugin.packageNames().then((packages) => {
                            expect(every(includedPackagesWithRepo, (repoName, packageName) => packages[packageName] === repoName)).toBe(true)
                            expect(every(excludedPackageWithRepos, (repoName, packageName) => !has(packages, packageName))).toBe(true)
                        })
                    })
                })

                it('should only include packages that match the pattern', retries, () => {
                    expect.assertions(4)

                    return withScenario('packages').run((scenario) => {
                        const pattern = '^package_repository_1'
                        const compiled = RegExp(pattern)
                        const scenarioPackages = scenario.packages()

                        const includedPackagesWithRepo = pickBy(scenarioPackages, (v, k) => compiled.test(v))
                        const excludedPackagesWithRepos = pickBy(scenarioPackages, (v, k) => !compiled.test(v))

                        expect(keys(includedPackagesWithRepo).length).toBeGreaterThan(0)
                        expect(keys(excludedPackagesWithRepos).length).toBeGreaterThan(0)

                        plugin.repositoryPattern = pattern

                        return plugin.packageNames().then((packages) => {
                            expect(every(includedPackagesWithRepo, (repoName, packageName) => packages[packageName] === repoName)).toBe(true)
                            expect(every(excludedPackagesWithRepos, (repoName, packageName) => !has(packages, packageName))).toBe(true)
                        })
                    })
                })
            })

            describe('allow_access/publish/unpublish', () => {
                const remoteUser = {
                    name: memberUsername,
                    real_groups: []
                }

                describe('with user permissions', () => {
                    // Here we use the beforeAll/afterAll to
                    // setup/teardown the scenario once, for
                    // all the tests
                    beforeAll(() => {
                        scenario = withScenario('user_permissions')

                        // Returning a promise here
                        // Jest knows how to handle it
                        return scenario.up()
                    })

                    afterAll(() => {
                        return scenario.down()
                    })

                    describe.each([
                        'admin',
                        'maintain',
                        'push'
                    ])('has write/read permissions for %s', (role) => {
                        // eslint-disable-next-line jest/expect-expect
                        it('can publish', retries, () => {
                            return hasUserRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_publish(remoteUser, pkgAccess, cb)
                            })
                        })

                        // eslint-disable-next-line jest/expect-expect
                        it('can unpublish', retries, () => {
                            return hasUserRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_unpublish(remoteUser, pkgAccess, cb)
                            })
                        })

                        // eslint-disable-next-line jest/expect-expect
                        it('can access', retries, () => {
                            return hasUserRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_access(remoteUser, pkgAccess, cb)
                            })
                        })
                    })

                    describe.each([
                        'triage',
                        'pull'
                    ])('has read-only permissions for %s', (role) => {
                        // eslint-disable-next-line jest/expect-expect
                        it('cannot publish', retries, () => {
                            return doesNotHaveUserRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_publish(remoteUser, pkgAccess, cb)
                            })
                        })

                        // eslint-disable-next-line jest/expect-expect
                        it('cannot unpublish', retries, () => {
                            return doesNotHaveUserRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_unpublish(remoteUser, pkgAccess, cb)
                            })
                        })

                        // eslint-disable-next-line jest/no-identical-title, jest/expect-expect
                        it('can access', retries, () => {
                            return hasUserRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_access(remoteUser, pkgAccess, cb)
                            })
                        })
                    })

                    it('does not allow access to unauthorized packages', retries, () => {
                        const pkg = first(Object.keys(scenario.scenario.packagesWithNoCollaborators()))

                        expect.assertions(1)

                        return plugin.packagePermissionsForUserForPackage(remoteUser, pkg).then((packagePermissions) => {
                            expect([...packagePermissions]).toStrictEqual([])
                        })
                    })
                })

                describe('with team permissions', () => {
                    // Here we use the beforeAll/afterAll to
                    // setup/teardown the scenario once, for
                    // all the tests
                    beforeAll(() => {
                        scenario = withScenario('team_permissions')
                        remoteUser.real_groups = map(scenario.scenario.teamsForUser(remoteUser.name), t => t.name)

                        // Returning a promise here
                        // Jest knows how to handle it
                        return scenario.up()
                    })

                    afterAll(() => {
                        remoteUser.real_groups = []
                        return scenario.down()
                    })

                    describe.each([
                        'admin',
                        'maintain',
                        'push'
                    ])('has write/read permissions for %s', (role) => {
                        // eslint-disable-next-line jest/expect-expect
                        it('can publish', retries, () => {
                            return hasTeamRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_publish(remoteUser, pkgAccess, cb)
                            })
                        })

                        // eslint-disable-next-line jest/expect-expect
                        it('can unpublish', retries, () => {
                            return hasTeamRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_unpublish(remoteUser, pkgAccess, cb)
                            })
                        })

                        // eslint-disable-next-line jest/expect-expect
                        it('can access', retries, () => {
                            return hasTeamRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_access(remoteUser, pkgAccess, cb)
                            })
                        })
                    })

                    describe.each([
                        'triage',
                        'pull'
                    ])('has read-only permissions for %s', (role) => {
                        // eslint-disable-next-line jest/expect-expect
                        it('cannot publish', retries, () => {
                            return doesNotHaveTeamRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_publish(remoteUser, pkgAccess, cb)
                            })
                        })

                        // eslint-disable-next-line jest/expect-expect
                        it('cannot unpublish', retries, () => {
                            return doesNotHaveTeamRole(scenario, remoteUser, role, (pkgAccess, cb) => {
                                plugin.allow_unpublish(remoteUser, pkgAccess, cb)
                            })
                        })

                        // eslint-disable-next-line jest/no-identical-title, jest/expect-expect
                        it('can access', retries, () => {
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

/**
 * @callback CheckFn
 * @param {PackageAccess} pkgAccess
 * @param {VerdaccioAccessCallback} cb
 */

/**
 * @typedef {import('./index').PackageAccess} PackageAccess
 * @typedef {import('./index').RemoteUser} RemoteUser
 * @typedef {import('./index').VerdaccioAccessCallback} VerdaccioAccessCallback
 */

/**
 * Checks that the user has the role.
 *
 * @param {GithubScenario} scenario - The scenario.
 * @param {RemoteUser} remoteUser - The user.
 * @param {GithubRESTRepoPermissions} role - The Github role.
 * @param {CheckFn} checkFn - The check callback.
 * @returns {Promise} - A promise on the array of checks.
 */
function hasUserRole (scenario, remoteUser, role, checkFn) {
    return userRoleCheck(scenario, remoteUser, role, true, checkFn)
}

/**
 * Checks that the user doesn't have the role.
 *
 * @param {GithubScenario} scenario - The scenario.
 * @param {RemoteUser} remoteUser - The user.
 * @param {GithubRESTRepoPermissions} role - The Github role.
 * @param {CheckFn} checkFn - The check callback.
 * @returns {Promise} - A promise on the array of checks.
 */
function doesNotHaveUserRole (scenario, remoteUser, role, checkFn) {
    return userRoleCheck(scenario, remoteUser, role, false, checkFn)
}

/**
 * A test helper for checking user permissions.
 *
 * @param {GithubScenario} scenario - The scenario.
 * @param {RemoteUser} remoteUser - The user.
 * @param {GithubRESTRepoPermissions} role - The Github role.
 * @param {boolean} hasPermission - Whether to check if the user has the permission, or doesn't have the permission.
 * @param {CheckFn} checkFn - The check callback.
 * @returns {Promise} - A promise on the array of checks.
 */
function userRoleCheck (scenario, remoteUser, role, hasPermission, checkFn) {
    const packages = scenario.scenario.packagesForUserRole(remoteUser.name, role)
    return roleCheck(packages, hasPermission, checkFn)
}

/**
 * Checks that the user has the role via teams.
 *
 * @param {GithubScenario} scenario - The scenario.
 * @param {RemoteUser} remoteUser - The user.
 * @param {GithubRESTRepoPermissions} role - The Github role.
 * @param {CheckFn} checkFn - The check callback.
 * @returns {Promise} - A promise on the array of checks.
 */
function hasTeamRole (scenario, remoteUser, role, checkFn) {
    return teamRoleCheck(scenario, remoteUser, role, true, checkFn)
}

/**
 * Checks that the user doesn't have the role via teams.
 *
 * @param {GithubScenario} scenario - The scenario.
 * @param {RemoteUser} remoteUser - The user.
 * @param {GithubRESTRepoPermissions} role - The Github role.
 * @param {CheckFn} checkFn - The check callback.
 * @returns {Promise} - A promise on the array of checks.
 */
function doesNotHaveTeamRole (scenario, remoteUser, role, checkFn) {
    return teamRoleCheck(scenario, remoteUser, role, false, checkFn)
}

/**
 * A test helper for checking user permissions via teams.
 *
 * @param {GithubScenario} scenario - The scenario.
 * @param {RemoteUser} remoteUser - The user.
 * @param {GithubRESTRepoPermissions} role - The Github role.
 * @param {boolean} hasPermission - Whether to check if the user has the permission, or doesn't have the permission.
 * @param {CheckFn} checkFn - The check callback.
 * @returns {Promise} - A promise on the array of checks.
 */
function teamRoleCheck (scenario, remoteUser, role, hasPermission, checkFn) {
    const packages = scenario.scenario.packagesForUserTeamRole(remoteUser.name, role)
    return roleCheck(packages, hasPermission, checkFn)
}

/**
 * A test helper for checking permissions.
 *
 * @param {Object<string, string>} packages - The packages.
 * @param {boolean} hasPermission - Whether to check if the user has the permission, or doesn't have the permission.
 * @param {CheckFn} checkFn - The check callback.
 * @returns {Promise} - A promise on the array of checks.
 */
function roleCheck (packages, hasPermission, checkFn) {
    // For each package, we're going to run a check
    // Plus the initial toBeGreaterThan check
    expect.assertions(Object.keys(packages).length + 1)
    expect(Object.keys(packages).length).toBeGreaterThan(0)

    let check
    const checks = []

    forOwn(packages, (repository, pkg) => {
        const pkgAccess = {
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
        }).then((result) => {
            expect(result).toBe(hasPermission)
        })
        checks.push(check)
    })

    return Promise.all(checks)
}
