const { src, dest } = require('gulp')

const fs = require('fs')
const jsdoc2md = require('jsdoc-to-markdown')

/**
 * Generate Markdown docs.
 *
 * @returns {Promise} Returns a Promise.
 */
function docs () {
    // Copy README
    src('./README.md').pipe(dest('./docs/', {
        overwrite: true
    }))

    // Generate Markdown from source code
    jsdoc2md.render({ files: 'src/lib/**/*.js' }).then(output => fs.writeFileSync('docs/API.md', output))

    return Promise.resolve()
}

exports.docs = docs
