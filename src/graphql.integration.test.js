import GraphQLClient from './graphql'
import { skipAllForUnit } from '@outcome-co/devkit/dist/utils/skipIf'
import { token, org, userMap, memberUsername, memberToken } from '../test/env'
import GithubScenario from '../test/github'

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

const logger = {
    warn: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn()
}

skipAllForUnit('graphql.js', () => {
    describe('GraphQLClient', () => {
        it('is able to make authenticated requests', () => {
            expect.assertions(1)

            const client = new GraphQLClient(memberToken, logger)
            const query = {
                viewer: {
                    login: true
                }
            }

            return client.get(query).then((response) => {
                expect(response.viewer.login === memberUsername).toBe(true)
            })
        })

        it('fetches multiple pages', () => {
            return withScenario('multiple_teams').run((scenario) => {
                const client = new GraphQLClient(token, logger)
                const teamCount = scenario.teams.length

                expect.assertions(2)

                // We need at least 2 teams to paginate
                expect(teamCount).toBeGreaterThan(1)

                const query = {
                    organization: {
                        __args: {
                            login: org
                        },
                        teams: {
                            __args: {
                                first: 1 // Limit the page size to 1
                            },
                            edges: {
                                node: {
                                    name: true
                                }
                            }
                        }
                    }
                }

                return client.getAll(query, 'organization.teams').then((response) => {
                    // Greater than or equal since there may be teams from other tests in the response
                    expect(response.organization.teams.edges.length).toBeGreaterThanOrEqual(teamCount)
                })
            })
        })
    })
})
