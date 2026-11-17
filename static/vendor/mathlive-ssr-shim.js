// mathlive/ssr 的轻量垫片：WinUIonWeb 仅在数学公式相关控件里用到这两个函数，
// 本项目不使用 MathLive 控件，这里提供最小实现以免加载完整的 MathLive 运行时。
export function convertAsciiMathToLatex(input) {
    return String(input == null ? '' : input);
}

export function convertLatexToMathMl(input) {
    return '<math><mtext>' + String(input == null ? '' : input) + '</mtext></math>';
}

export default { convertAsciiMathToLatex, convertLatexToMathMl };