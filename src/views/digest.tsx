import type { NightDigest } from '../digest/types.js';

const MISSING = '—';

export function Digest(props: { digest: NightDigest }) {
  const { night, rows, badLines } = props.digest;
  return (
    <>
      <h1>{night}</h1>
      {rows.length === 0 ? (
        <p>nothing ran</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>job</th>
              <th>owner</th>
              <th>runs</th>
              <th>retries</th>
              <th>last status</th>
              <th>last error</th>
              <th>first</th>
              <th>last</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr>
                <td>{row.job}</td>
                <td>{row.owner ?? MISSING}</td>
                <td>{row.runs}</td>
                {row.retries >= 3 ? <td class="warn">{row.retries} !</td> : <td>{row.retries}</td>}
                {row.lastStatus === 'fail' ? (
                  <td class="warn">{row.lastStatus} !</td>
                ) : (
                  <td>{row.lastStatus}</td>
                )}
                <td>{row.lastError ?? MISSING}</td>
                <td>{row.firstAt}</td>
                <td>{row.lastAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {badLines > 0 ? <p class="mute">bad lines: {badLines}</p> : null}
    </>
  );
}
