import del from 'del'

export const clean = () => {
    return del(['./dist', './*.log'])
}

export const postbuild = () => {
    return del(['./dist/**/*.test.js', './dist/**/*.spec.js'])
}
