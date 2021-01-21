import { Scenario, UserMap } from './scenario'
import crypto from 'crypto'
import { Octokit } from '@octokit/rest'
import promiseRetry from 'promise-retry'
import { map } from 'lodash'
import path from 'path'
import { withRateLimiting } from './rateLimiting'
import { RequestError } from '@octokit/request-error'
import { RepositoryPermission } from '../schemaTypes'

type RESTRepositoryPermission = 'pull' | 'push' | 'admin' | 'maintain' | 'triage'

/* istanbul ignore next */
const mapGraphQLPermissionsToRest = (graphQLPermission: RepositoryPermission): RESTRepositoryPermission => {
    switch (graphQLPermission) {
        case 'ADMIN':
            return 'admin'
        case 'MAINTAIN':
            return 'maintain'
        case 'WRITE':
            return 'push'
        case 'TRIAGE':
            return 'triage'
        case 'READ':
            return 'pull'
        default:
            throw new Error('Unknown permission')
    }
}

/**
 * Encode a value as Base64.
 *
 * @param content - The value to encode.
 * @returns The Base64 encoded value.
 */
const toBase64 = (content: string): string => {
    return Buffer.from(content).toString('base64')
}

/* istanbul ignore next */
class WrappedError extends Error {
    err: RequestError

    /**
     * Init.
     *
     * @param err - The GH error.
     */
    constructor(err: RequestError) {
        super(err.message)
        this.err = err
    }

    get code() {
        return this.err.status
    }
}

/**
 * Wraps a GH error to make it compatible with `promiseRetry`.
 *
 * @param retry - The retry function.
 * @param err - The GH error.
 */
/* istanbul ignore next */
const retryGithubError = (retry: (err: unknown) => never, err: RequestError) => {
    retry(new WrappedError(err))
}

type ScenarioCallback = (scenario: Scenario) => Promise<void>

export default class GithubScenario {
    readonly scenario: Scenario

    readonly organization: string
    readonly client: Octokit

    /**
     * Instantiate a new Github Scenario.
     *
     * @param token - The Github token to use.
     * @param organization - The Github organization.
     * @param scenario - The scenario data.
     */
    constructor(token: string, organization: string, scenario: Scenario) {
        this.organization = organization
        this.scenario = scenario
        this.client = new Octokit({ auth: token })
    }

    get sessionId(): string {
        return this.scenario.sessionId
    }

    static load(token: string, organization: string, name: string, userMap: UserMap): Promise<GithubScenario> {
        const sessionId = this.generateSessionId()
        const scenarioPath = path.join(__dirname, 'scenarios', `${name}.json`)

        return import(scenarioPath)
            .then(data => Scenario.parse(sessionId, userMap, data))
            .then(scenario => {
                return new GithubScenario(token, organization, scenario)
            })
    }

    static generateSessionId(): string {
        const sessionKey = 'verdaccio'
        const shasum = crypto.createHash('sha1')

        shasum.update(Date.now().toString())

        const sessionHash = shasum.digest('hex')
        const shortHash = sessionHash.slice(0, 8)

        return `${sessionKey}-${shortHash}`
    }

    /**
     * Runs the provided function with the scenario.
     *
     * @param fn - The function to run in the scenario.
     * @returns The promise of the scenario reset.
     */
    run(fn: ScenarioCallback): Promise<void> {
        return this.up()
            .then(() => {
                return fn(this.scenario)
            })
            .finally(() => {
                // eslint-disable-next-line no-void
                void this.down()
            })
    }

    /**
     * Resets the scenario, then builds it.
     *
     * @returns The promise of the built scenario.
     */
    up(): Promise<void> {
        return this.reset().then(() => this.build())
    }

    down(): Promise<void> {
        return this.reset()
    }

    build(): Promise<void> {
        return this.buildRepos().then(() => this.buildTeams())
    }

    buildTeams(): Promise<void> {
        const operations = map(this.scenario.teams, team => {
            const createdTeam = this.client.teams.create({ org: this.organization, name: team.name })

            const addUsers = createdTeam.then(createdTeam => {
                const ops = map(team.members, member => {
                    return promiseRetry({ retries: 3 }, retry => {
                        return withRateLimiting(() => {
                            /* istanbul ignore next */
                            return this.client.teams
                                .addOrUpdateMembershipForUserInOrg({
                                    org: this.organization,
                                    team_slug: createdTeam.data.slug,
                                    username: member
                                })
                                .catch((err: RequestError) => retryGithubError(retry, err))
                        })
                    })
                })

                return Promise.all(ops)
            })

            const setRepoPermissions = createdTeam.then(createdTeam => {
                const ops = map(team.repositories, repo => {
                    return promiseRetry({ retries: 3 }, retry => {
                        return withRateLimiting(() => {
                            /* istanbul ignore next */
                            return this.client.teams
                                .addOrUpdateRepoPermissionsInOrg({
                                    org: this.organization,
                                    owner: this.organization,
                                    repo: repo.name,
                                    permission: mapGraphQLPermissionsToRest(repo.role),
                                    team_slug: createdTeam.data.slug
                                })
                                .catch(err => retryGithubError(retry, err))
                        })
                    })
                })

                return Promise.all(ops)
            })

            return Promise.all([addUsers, setRepoPermissions])
        })

        return Promise.all(operations).then(() => Promise.resolve())
    }

    buildRepos(): Promise<void> {
        const operations = map(this.scenario.repositories, repo => {
            const createdRepo = this.client.repos.createInOrg({ org: this.organization, name: repo.name })

            const addUsers = createdRepo.then(() => {
                const ops = map(repo.collaborators, collaborator => {
                    return promiseRetry({ retries: 3 }, retry => {
                        return withRateLimiting(() => {
                            /* istanbul ignore next */
                            return this.client.repos
                                .addCollaborator({
                                    owner: this.organization,
                                    repo: repo.name,
                                    username: collaborator.name,
                                    permission: mapGraphQLPermissionsToRest(collaborator.role)
                                })
                                .catch(err => retryGithubError(retry, err))
                        })
                    })
                })

                return Promise.all(ops)
            })

            const addFiles = createdRepo.then(() => {
                const ops = map(repo.files, (fileContent, file) => {
                    return promiseRetry({ retries: 3 }, retry => {
                        return withRateLimiting(() => {
                            /* istanbul ignore next */
                            return this.client.repos
                                .createOrUpdateFileContents({
                                    owner: this.organization,
                                    repo: repo.name,
                                    path: file,
                                    message: 'Test File',
                                    content: toBase64(fileContent)
                                })
                                .catch(err => retryGithubError(retry, err))
                        })
                    })
                })

                return Promise.all(ops)
            })

            return Promise.all([addUsers, addFiles])
        })

        return Promise.all(operations).then(() => Promise.resolve())
    }

    reset(): Promise<void> {
        const scenarioTeamNames = this.scenario.teamNames()
        const scenarioRepoNames = this.scenario.repoNames()

        const deleteTeams = this.client.paginate(this.client.teams.list, { org: this.organization }).then(teams => {
            const deletions = map(teams, t => {
                /* istanbul ignore else */
                if (scenarioTeamNames.has(t.name)) {
                    return withRateLimiting(() => {
                        return this.client.teams
                            .deleteInOrg({
                                org: this.organization,
                                team_slug: t.slug

                                // We want to swallow the errors that may occur
                                // when deleting a team, since it may just be that
                                // the team was already deleted when its parent
                                // was deleted
                            })
                            .catch()
                            .then(() => Promise.resolve())
                    })
                } else {
                    return Promise.resolve()
                }
            })

            return Promise.all(deletions)
        })

        const deleteRepos = this.client.paginate(this.client.repos.listForOrg, { org: this.organization }).then(repos => {
            const deletions = map(repos, r => {
                if (scenarioRepoNames.has(r.name)) {
                    return withRateLimiting(() => {
                        return this.client.repos
                            .delete({
                                owner: this.organization,
                                repo: r.name
                            })
                            .then(() => Promise.resolve())
                    })
                } else {
                    return Promise.resolve()
                }
            })

            return Promise.all(deletions)
        })

        return Promise.all([deleteTeams, deleteRepos]).then(() => Promise.resolve())
    }
}
