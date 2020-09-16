require('dotenv').config()

export const token = process.env.VERDACCIO_TEST_TOKEN
export const org = process.env.VERDACCIO_TEST_ORGANIZATION

export const memberUsername = process.env.VERDACCIO_TEST_MEMBER_USERNAME
export const memberToken = process.env.VERDACCIO_TEST_MEMBER_TOKEN
export const adminUsername = process.env.VERDACCIO_TEST_ADMIN_USERNAME
export const nonMemberUsername = process.env.VERDACCIO_TEST_NONMEMBER_USERNAME

export const userMap = {
    $MEMBER_USER: memberUsername,
    $ADMIN_USER: adminUsername
}

export const insideGithubActions = process.env.GITHUB_ACTIONS === 'true'
