import dts from "rollup-plugin-dts";

export default {
  input: "src/index.ts",
  output: {
    file: "dist/public.d.ts",
    format: "es",
  },
  plugins: [dts()],
};
