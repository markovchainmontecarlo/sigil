import { dispatch } from "sigil";

export async function shipWhenClean(
  repo: string,
  backlogFile: string,
) {
  return dispatch({
    repo,
    backlogFile,
    deliveryPolicy: "mergeWhenGreen",
  });
}
