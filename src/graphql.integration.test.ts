import { GraphQLClient, PageInfoExtractor } from './graphql'
import { Logger } from '@verdaccio/types'
import { skipAllForUnit } from '@outcome-co/devkit/dist/utils/skipIf'
import { token, org, userMap, memberUsername, memberToken } from './test/env'
import GithubScenario from './test/github'

import * as s from './schemaTypes'

import { reduce } from 'lodash'

jest.setTimeout(300000)

/**
 * Load the scenario at the given path.
 *
 * @param name - The name of the JSON scenario.
 * @returns A GithubScenario instance.
 */
function withScenario(name: string): Promise<GithubScenario> {
    return GithubScenario.load(token, org, name, userMap)
}

const logger: Logger = <Logger>(<unknown>{
    warn: jest.fn(),
    trace: jest.fn(),
    error: jest.fn()
})

skipAllForUnit('graphql.js', () => {
    describe('GraphQLClient', () => {
        it('is able to make authenticated requests', () => {
            expect.assertions(1)

            const client = new GraphQLClient(memberToken, logger)
            return client
                .get<s.VerifyUserIdentityQuery, s.VerifyUserIdentityQueryVariables>(s.VerifyUserIdentity)
                .then(response => {
                    expect(response.viewer.login === memberUsername).toBe(true)
                })
        })

        it('fetches multiple pages', () => {
            return withScenario('multiple_teams').then(githubScenario => {
                return githubScenario.run(scenario => {
                    const client = new GraphQLClient(token, logger)
                    const teamCount = scenario.teams.length

                    expect.assertions(2)

                    // We need at least 2 teams to paginate
                    expect(teamCount).toBeGreaterThan(1)

                    const pageInfoExtractor: PageInfoExtractor<s.GetOrganizationTeamNamesQuery> = page =>
                        page.organization?.teams.pageInfo

                    return client
                        .getAll<s.GetOrganizationTeamNamesQuery, s.GetOrganizationTeamNamesQueryVariables>(
                            s.GetOrganizationTeamNames,
                            { login: org, first: 1 },
                            pageInfoExtractor
                        )
                        .then(pages => {
                            const teams = reduce(
                                pages,
                                (teams, page) => {
                                    const pageTeams = reduce(
                                        page.organization?.teams.edges ?? [],
                                        (pageTeams, edge) => {
                                            if (edge?.node) {
                                                pageTeams.push(edge.node)
                                            }
                                            return pageTeams
                                        },
                                        <Pick<s.Team, 'name'>[]>[]
                                    )

                                    return [...teams, ...pageTeams]
                                },
                                <Pick<s.Team, 'name'>[]>[]
                            )
                            // Greater than or equal since there may be teams from other tests in the response
                            expect(teams.length).toBeGreaterThanOrEqual(teamCount)
                        })
                })
            })
        })
    })
})
