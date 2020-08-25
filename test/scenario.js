// @ts-nocheck
/* eslint-disable jsdoc/require-jsdoc */

import { Model, ArrayModel, BasicModel } from 'objectmodel'
import assert from 'assert'
import { map, mapValues, get, reduce, some, includes, filter } from 'lodash'
import Mustache from 'mustache'

class SessionObject extends Model({ sessionId: String }) {
    get sessionId () {
        return this._sessionId
    }

    set sessionId (sessionId) {
        assert(this._sessionId === undefined)
        this._sessionId = sessionId
    }
}

class NamedSessionObject extends SessionObject.extend({ name: String }) {
    set name (value) {
        this._name = value
    }

    get name () {
        if (this._name !== undefined) {
            if (this.sessionId) {
                return `${this._name}-${this.sessionId}`
            }
            return this._name
        }
        return undefined
    }
}

const UserMembership = Model({ name: String })

const RepositoryRole = BasicModel(['admin', 'maintain', 'pull', 'triage', 'push'])
const RepositoryMembership = Model({ name: String, role: RepositoryRole })

const Meta = Model({ package: [String] })

/**
 * @property {Array<RepositoryMembership>} collaborators
 */
class Repository extends NamedSessionObject
    .extend({ files: [Object], meta: [Meta], collaborators: [ArrayModel(RepositoryMembership)] })
    .defaultTo({ files: {}, meta: {}, collaborators: [] }) {
    updateUsers (userMap) {
        this.collaborators.forEach((c) => {
            c.name = get(userMap, c.name, c.name)
        })
    }

    get files () {
        // Replace the sessionId placeholder, on the fly
        const sessionId = this.sessionId
        return mapValues(this._files, (fileContent) => Mustache.render(fileContent, { sessionId }))
    }

    set files (files) {
        this._files = files
    }

    get meta () {
        // Replace the sessionId placeholder, on the fly
        const sessionId = this.sessionId
        return mapValues(this._meta, (value) => Mustache.render(value, { sessionId }))
    }

    set meta (meta) {
        this._meta = meta
    }
}

class TeamRepositoryAccess extends NamedSessionObject.extend({ role: RepositoryRole }) {}

class Team extends NamedSessionObject.extend({ members: [ArrayModel(String)], repositories: [ArrayModel(TeamRepositoryAccess)] })
    .defaultTo({ members: [], repositories: [] })
    // Not really an assertion, but since
    // assertions are called before validating child
    // objects, it allows us to propagate the sessionId
    .assert((team) => {
        team.repositories.forEach((repo) => {
            if (!repo.sessionId) {
                repo.sessionId = team.sessionId
            }
        })
        return true
    }) {
    updateUsers (userMap) {
        this.members = map(this.members, (m) => get(userMap, m, m))
    }
}

/**
 * Ensure that all of the team members are valid users.
 *
 * @param {Scenario} scenario - The scenario to validate.
 * @returns {boolean} - Returns true if valid.
 */
function checkTeamMemberships (scenario) {
    const users = map(scenario.users, u => u.name)

    scenario.teams.forEach((t) => {
        if (!(t.members || []).every(m => users.includes(m))) {
            return false
        }
    })

    return true
}

/**
 * Ensure that all of the collaborators are valid users.
 *
 * @param {Scenario} scenario - The scenario to validate.
 * @returns {boolean} - Returns true if valid.
 */
function checkRepositoryCollaborators (scenario) {
    const userNames = map(scenario.users, u => u.name)

    scenario.repositories.forEach((r) => {
        const repoUsers = map(r.collaborators, c => c.name)
        if (!repoUsers.every(u => userNames.includes(u))) {
            return false
        }
    })

    return true
}

/**
 * Ensure that all of the team repositories are valid.
 *
 * @param {Scenario} scenario - The scenario to validate.
 * @returns {boolean} - Returns true if valid.
 */
function checkTeamRepositories (scenario) {
    const allRepos = map(scenario.repositories, r => r.name)

    scenario.teams.forEach((t) => {
        const teamRepos = map(t.repositories, r => r.name)
        if (!teamRepos.every((r) => allRepos.includes(r))) {
            return false
        }
    })

    return true
}

class Scenario extends SessionObject.extend({ repositories: [ArrayModel(Repository)], users: ArrayModel(UserMembership), teams: [ArrayModel(Team)] })
    .defaultTo({ users: [], repositories: [], teams: [] })
    .assert(checkRepositoryCollaborators)
    .assert(checkTeamMemberships)
    .assert(checkTeamRepositories) {
    static create (sessionId, userMap, properties) {
        const repositories = properties.repositories

        // Propagate the sessionId before validation
        if (repositories) {
            repositories.forEach((repo) => {
                repo.sessionId = sessionId
            })
        }

        const teams = properties.teams

        if (teams) {
            teams.forEach((team) => {
                team.sessionId = sessionId
            })
        }

        const instance = new Scenario({ sessionId, ...properties })
        instance.updateUsers(userMap)

        return instance
    }

    /**
     * Returns the set of unique team names.
     *
     * @returns {Set<string>} The set of team names.
     */
    teamNames () {
        return new Set(map(this.teams, t => t.name))
    }

    /**
     * Returns the set of unique repository names.
     *
     * @returns {Set<string>} The set of repository names.
     */
    repoNames () {
        return new Set(map(this.repositories, r => r.name))
    }

    /**
     * Returns the mapping of packages to repositories from the scenario.
     *
     * @returns { Object<string, string> } - The mapping of packages to repositories from the scenario.
     */
    packages () {
        return reduce(this.repositories, (packages, repo) => {
            if (repo.meta.package) {
                packages[repo.meta.package] = repo.name
            }
            return packages
        }, {})
    }

    /**
     * Returns the mapping of packages to repositories from the scenario, for
     * the provided user with the given role.
     *
     * @param {string} user - The username.
     * @param {string} role - The user's role.
     * @returns { Object<string, string> } - The mapping of packages to repositories from the scenario.
     */
    packagesForUserRole (user, role) {
        return reduce(this.repositories, (packages, repo) => {
            if (repo.meta.package && some(repo.collaborators, collaborator => collaborator.name === user && collaborator.role === role)) {
                packages[repo.meta.package] = repo.name
            }
            return packages
        }, {})
    }

    packagesForUserTeamRole (user, role) {
        const validReposViaTeams = reduce(this.teams, (repos, team) => {
            if (includes(team.members, user)) {
                team.repositories.forEach((repo) => {
                    if (repo.role === role) {
                        repos.push(repo.name)
                    }
                })
            }
            return repos
        }, [])

        return reduce(this.repositories, (packages, repo) => {
            if (repo.meta.package && includes(validReposViaTeams, repo.name)) {
                packages[repo.meta.package] = repo.name
            }
            return packages
        }, {})
    }

    /**
     * Returns the packages that do not have any direct
     * collaborators.
     *
     * @returns { Object<string, string> } - The mapping of packages to repositories from the scenario.
     */
    packagesWithNoCollaborators () {
        return reduce(this.repositories, (packages, repo) => {
            if (repo.meta.package && repo.collaborators.length === 0) {
                packages[repo.meta.package] = repo.name
            }
            return packages
        }, {})
    }

    teamsForUser (user) {
        return filter(this.teams, (team) => includes(team.members, user))
    }

    updateUsers (userMap) {
        this.users.forEach((u) => {
            u.name = get(userMap, u.name, u.name)
        })

        this.teams.forEach((t) => {
            t.updateUsers(userMap)
        })

        this.repositories.forEach((r) => {
            r.updateUsers(userMap)
        })
    }
}

export default Scenario
