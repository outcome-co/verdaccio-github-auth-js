import Scenario from './scenario'
import crypto from 'crypto'
import { Octokit } from '@octokit/rest'
import promiseRetry from 'promise-retry'
import { map } from 'lodash'
import path from 'path'

/**
 * Loads a scenario from a JSON file.
 *
 * The user map is an object with ADMIN_USER and MEMBER_USER
 * keys, mapped to the real usernames.
 *
 * The session ID is a unique identifier for the test run.
 *
 * @param {string} name - The name of the JSON file containing the scenario.
 * @param {object} userMap - The user map.
 * @param {string} sessionId - The session ID.
 * @returns {Scenario} - The loaded scenario.
 */
function loadScenario (name, userMap, sessionId) {
    const scenarioPath = path.join(__dirname, 'scenarios', `${name}.json`)
    const scenarioData = require(scenarioPath)

    return Scenario.create(sessionId, userMap, scenarioData)
}

/**
 * Encode a value as Base64.
 *
 * @param {*} content - The value to encode.
 * @returns {string} - The Base64 encoded value.
 */
function toBase64 (content) {
    return Buffer.from(content).toString('base64')
}

export default class GithubScenario {
    /**
     * Instantiate a new Github Scenario.
     *
     * @param {string} token - The Github token to use.
     * @param {string} organization - The Github organization.
     * @param {string} path - The path to the JSON file containing the scenario.
     * @param {Object<string, string>} userMap - A map of user templates to actual users.
     */
    constructor (token, organization, path, userMap) {
        this.sessionId = this.generateSessionId()
        this.scenario = loadScenario(path, userMap, this.sessionId)

        this.client = new Octokit({ auth: token })
        this.organization = organization
    }

    generateSessionId () {
        const sessionKey = 'verdaccio'
        const shasum = crypto.createHash('sha1')

        shasum.update(Date.now().toString())

        const sessionHash = shasum.digest('hex')
        const shortHash = sessionHash.slice(0, 8)

        return `${sessionKey}-${shortHash}`
    }

    /**
     * @callback ScenarioCallback
     * @param {Scenario} fn
     */

    /**
     * Runs the provided function with the scenario.
     *
     * @param {ScenarioCallback} fn - The function to run in the scenario.
     * @returns {Promise} - The promise of the scenario reset.
     */
    run (fn) {
        return this.up().then(() => {
            return fn(this.scenario)
        }).finally(() => {
            return this.down()
        })
    }

    /**
     * Resets the scenario, then builds it.
     *
     * @returns {Promise} - The promise of the built scenario.
     */
    up () {
        return this.reset().then(() => this.build())
    }

    /**
     * Resets the scenario.
     *
     * @returns {Promise} - The promise of the scenario reset.
     */
    down () {
        return this.reset()
    }

    build () {
        return this.buildRepos().then(() => this.buildTeams())
    }

    buildTeams () {
        // @ts-ignore
        const operations = map(this.scenario.teams, (team) => {
            const createdTeam = this.client.teams.create({ org: this.organization, name: team.name })

            const addUsers = createdTeam.then((createdTeam) => {
                const ops = map(team.members, (member) => {
                    return promiseRetry({ retries: 3 }, (retry) => {
                        return this.client.teams.addOrUpdateMembershipForUserInOrg({
                            org: this.organization,
                            team_slug: createdTeam.data.slug,
                            username: member
                        }).catch(retry)
                    })
                })

                return Promise.all(ops)
            })

            const setRepoPermissions = createdTeam.then((createdTeam) => {
                const ops = map(team.repositories, (repo) => {
                    return promiseRetry({ retries: 3 }, (retry) => {
                        return this.client.teams.addOrUpdateRepoPermissionsInOrg({
                            org: this.organization,
                            owner: this.organization,
                            repo: repo.name,
                            permission: repo.role,
                            team_slug: createdTeam.data.slug
                        }).catch(retry)
                    })
                })

                return Promise.all(ops)
            })

            return Promise.all([addUsers, setRepoPermissions])
        })

        return Promise.all(operations)
    }

    buildRepos () {
        // @ts-ignore
        const operations = map(this.scenario.repositories, (repo) => {
            const createdRepo = this.client.repos.createInOrg({ org: this.organization, name: repo.name })

            const addUsers = createdRepo.then(() => {
                const ops = map(repo.collaborators, (collaborator) => {
                    return promiseRetry({ retries: 3 }, (retry) => {
                        return this.client.repos.addCollaborator({
                            owner: this.organization,
                            repo: repo.name,
                            username: collaborator.name,
                            permission: collaborator.role
                        }).catch(retry)
                    })
                })

                return Promise.all(ops)
            })

            const addFiles = createdRepo.then(() => {
                const ops = map(repo.files, (fileContent, file) => {
                    return promiseRetry({ retries: 3 }, (retry) => {
                        return this.client.repos.createOrUpdateFileContents({
                            owner: this.organization,
                            repo: repo.name,
                            path: file,
                            message: 'Test File',
                            content: toBase64(fileContent)
                        })
                    })
                })

                return Promise.all(ops)
            })

            return Promise.all([addUsers, addFiles])
        })

        return Promise.all(operations)
    }

    reset () {
        const scenarioTeamNames = this.scenario.teamNames()
        const scenarioRepoNames = this.scenario.repoNames()

        const deleteTeams = this.client.paginate(this.client.teams.list, { org: this.organization })
            .then((teams) => {
                const deletions = map(teams, (t) => {
                    if (scenarioTeamNames.has(t.name)) {
                        return this.client.teams.deleteInOrg({
                            org: this.organization,
                            team_slug: t.slug

                        // We want to swallow the errors that may occur
                        // when deleting a team, since it may just be that
                        // the team was already deleted when its parent
                        // was deleted
                        }).catch(() => {})
                    } else {
                        return true
                    }
                })

                return Promise.all(deletions)
            })

        const deleteRepos = this.client.paginate(this.client.repos.listForOrg, { org: this.organization })
            .then((repos) => {
                const deletions = map(repos, (r) => {
                    if (scenarioRepoNames.has(r.name)) {
                        return this.client.repos.delete({
                            owner: this.organization,
                            repo: r.name
                        })
                    } else {
                        return true
                    }
                })

                return Promise.all(deletions)
            })

        return Promise.all([deleteTeams, deleteRepos])
    }
}
