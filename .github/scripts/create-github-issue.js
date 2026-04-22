const assigneeManager = require('./github-assignee-manager');

module.exports = async function({github, context, core}) {
  const jiraKey = process.env.JIRA_ISSUE_KEY;
  
  if (!jiraKey) {
    throw new Error('JIRA issue key not provided');
  }
  
  console.log(`🔗 Processing JIRA issue: ${jiraKey}`);
  console.log(`📋 JIRA URL: ${process.env.JIRA_BASE_URL}/browse/${jiraKey}`);

  // 재시도 로직: 기존 이슈 정리
  console.log(`🔍 Checking for existing GitHub issues with JIRA key: ${jiraKey}`);
  
  try {
    // 1. 제목에 JIRA key를 포함하는 열린 이슈 검색
    const existingIssues = await github.rest.search.issuesAndPullRequests({
      q: `repo:${context.repo.owner}/${context.repo.repo} is:open is:issue "${jiraKey}" in:title`,
      sort: 'created',
      order: 'desc'
    });

    if (existingIssues.data.total_count > 0) {
      console.log(`📋 Found ${existingIssues.data.total_count} existing open issue(s) with JIRA key ${jiraKey}`);
      
      for (const existingIssue of existingIssues.data.items) {
        console.log(`🔧 Processing existing issue #${existingIssue.number}: ${existingIssue.title}`);
        
        // 2. 해당 이슈에 연결된 PR 검색 및 처리
        try {
          console.log(`🔍 Searching for PRs related to issue #${existingIssue.number} and JIRA key ${jiraKey}`);
          
          // 모든 관련 PR 수집
          const allRelatedPRs = new Set();
          
          // A. GitHub의 linked PR 검색 (여러 형태로 시도)
          const linkedQueries = [
            `repo:${context.repo.owner}/${context.repo.repo} is:open is:pr linked:issue-${existingIssue.number}`,
            `repo:${context.repo.owner}/${context.repo.repo} is:open is:pr #${existingIssue.number}`,
            `repo:${context.repo.owner}/${context.repo.repo} is:open is:pr "${existingIssue.number}"`
          ];
          
          for (const query of linkedQueries) {
            try {
              const linkedPRs = await github.rest.search.issuesAndPullRequests({ q: query });
              console.log(`🔍 Query "${query}" found ${linkedPRs.data.total_count} PRs`);
              linkedPRs.data.items.forEach(pr => {
                console.log(`   Found linked PR #${pr.number}: ${pr.title}`);
                allRelatedPRs.add(pr.number);
              });
            } catch (searchError) {
              console.log(`⚠️ Search query failed: "${query}" - ${searchError.message}`);
            }
          }

          // B. 이슈 본문에서 PR 링크 검색
          const prMentionRegex = /#(\d+)/g;
          const mentionedPRNumbers = [];
          let match;
          while ((match = prMentionRegex.exec(existingIssue.body || '')) !== null) {
            mentionedPRNumbers.push(parseInt(match[1]));
          }
          console.log(`🔍 Found ${mentionedPRNumbers.length} PR mentions in issue body: [${mentionedPRNumbers.join(', ')}]`);

          // C. JIRA key와 관련된 copilot 브랜치 PR 검색 (더 구체적으로)
          const copilotQueries = [
            `repo:${context.repo.owner}/${context.repo.repo} is:open is:pr head:copilot/fix-${jiraKey.toLowerCase()}`,
            `repo:${context.repo.owner}/${context.repo.repo} is:open is:pr head:copilot/${jiraKey.toLowerCase()}`,
            `repo:${context.repo.owner}/${context.repo.repo} is:open is:pr "${jiraKey}" head:copilot/*`
          ];
          
          for (const query of copilotQueries) {
            try {
              const copilotPRs = await github.rest.search.issuesAndPullRequests({ q: query });
              console.log(`🔍 Copilot query "${query}" found ${copilotPRs.data.total_count} PRs`);
              copilotPRs.data.items.forEach(pr => {
                console.log(`   Found copilot PR #${pr.number}: ${pr.title} (branch: ${pr.head.ref})`);
                allRelatedPRs.add(pr.number);
              });
            } catch (searchError) {
              console.log(`⚠️ Copilot search query failed: "${query}" - ${searchError.message}`);
            }
          }

          // D. 모든 열린 copilot/* 브랜치 PR을 검색하고 관련성 확인
          try {
            const allCopilotPRs = await github.rest.search.issuesAndPullRequests({
              q: `repo:${context.repo.owner}/${context.repo.repo} is:open is:pr head:copilot/*`,
            });
            console.log(`🔍 Found ${allCopilotPRs.data.total_count} total open copilot/* PRs`);
            
            allCopilotPRs.data.items.forEach(pr => {
              const branchName = pr.head.ref;
              const isRelated = branchName.includes(jiraKey.toLowerCase()) || 
                              pr.body?.includes(`#${existingIssue.number}`) ||
                              pr.body?.includes(jiraKey) ||
                              pr.title?.includes(jiraKey);
              
              console.log(`   Checking PR #${pr.number} (branch: ${branchName}) - Related: ${isRelated}`);
              if (isRelated) {
                allRelatedPRs.add(pr.number);
              }
            });
          } catch (error) {
            console.log(`⚠️ Error searching all copilot PRs: ${error.message}`);
          }

          // E. 본문에서 언급된 PR들 확인
          for (const prNumber of mentionedPRNumbers) {
            try {
              const pr = await github.rest.pulls.get({
                owner: context.repo.owner,
                repo: context.repo.repo,
                pull_number: prNumber
              });
              if (pr.data.state === 'open') {
                console.log(`   Found mentioned open PR #${prNumber}: ${pr.data.title}`);
                allRelatedPRs.add(prNumber);
              } else {
                console.log(`   Mentioned PR #${prNumber} is already ${pr.data.state}`);
              }
            } catch (error) {
              console.log(`⚠️ Could not fetch mentioned PR #${prNumber}: ${error.message}`);
            }
          }

          console.log(`📋 Total related PRs to process: ${allRelatedPRs.size} - [${Array.from(allRelatedPRs).join(', ')}]`);

          // 3. 관련된 모든 PR 닫기 및 브랜치 삭제
          let closedPRCount = 0;
          let deletedBranchCount = 0;
          
          for (const prNumber of allRelatedPRs) {
            try {
              console.log(`🔒 Processing PR #${prNumber}...`);
              
              // PR 정보 가져오기
              const prData = await github.rest.pulls.get({
                owner: context.repo.owner,
                repo: context.repo.repo,
                pull_number: prNumber
              });

              console.log(`   PR #${prNumber} info: ${prData.data.title} (state: ${prData.data.state}, branch: ${prData.data.head.ref})`);

              if (prData.data.state === 'open') {
                // PR 닫기
                await github.rest.pulls.update({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  pull_number: prNumber,
                  state: 'closed'
                });
                console.log(`   ✅ Successfully closed PR #${prNumber}`);
                closedPRCount++;

                // copilot/* 브랜치인 경우 브랜치 삭제
                const branchName = prData.data.head.ref;
                if (branchName.startsWith('copilot/')) {
                  try {
                    console.log(`   🗑️ Deleting branch: ${branchName}`);
                    await github.rest.git.deleteRef({
                      owner: context.repo.owner,
                      repo: context.repo.repo,
                      ref: `heads/${branchName}`
                    });
                    console.log(`   ✅ Successfully deleted branch: ${branchName}`);
                    deletedBranchCount++;
                  } catch (branchError) {
                    console.log(`   ⚠️ Could not delete branch ${branchName}: ${branchError.message}`);
                  }
                } else {
                  console.log(`   ℹ️ Branch ${branchName} is not a copilot branch, skipping deletion`);
                }
              } else {
                console.log(`   ℹ️ PR #${prNumber} is already ${prData.data.state}, skipping`);
              }
            } catch (prError) {
              console.log(`   ❌ Error processing PR #${prNumber}: ${prError.message}`);
            }
          }
          
          console.log(`📊 PR processing summary: ${closedPRCount} PRs closed, ${deletedBranchCount} branches deleted`);

        } catch (prSearchError) {
          console.log(`⚠️ Error during PR search and cleanup: ${prSearchError.message}`);
        }

        // 4. 기존 이슈 닫기
        try {
          console.log(`🔒 Closing existing issue #${existingIssue.number}`);
          await github.rest.issues.update({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: existingIssue.number,
            state: 'closed'
          });
          console.log(`✅ Successfully closed issue #${existingIssue.number}`);
        } catch (issueError) {
          console.log(`⚠️ Error closing issue #${existingIssue.number}: ${issueError.message}`);
        }
      }

      // 5. JIRA 이슈에서 해당 GitHub 이슈 번호가 포함된 코멘트 삭제
      try {
        console.log(`🧹 Cleaning up JIRA comments for issue ${jiraKey}`);
        
        const jiraAuth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
        
        // JIRA 이슈의 모든 코멘트 가져오기
        const jiraCommentsResponse = await fetch(`${process.env.JIRA_BASE_URL}/rest/api/3/issue/${jiraKey}/comment`, {
          method: 'GET',
          headers: {
            'Authorization': `Basic ${jiraAuth}`,
            'Accept': 'application/json'
          }
        });

        if (jiraCommentsResponse.ok) {
          const jiraComments = await jiraCommentsResponse.json();
          console.log(`📋 Found ${jiraComments.comments.length} total JIRA comments to analyze`);
          
          // 닫힌 GitHub 이슈 번호들 수집
          const closedIssueNumbers = existingIssues.data.items.map(issue => issue.number.toString());
          console.log(`🔍 Looking for comments containing GitHub issue numbers: [${closedIssueNumbers.join(', ')}]`);
          
          let deletedCommentsCount = 0;
          
          for (const comment of jiraComments.comments) {
            console.log(`🔍 Analyzing JIRA comment ${comment.id} (author: ${comment.author.displayName})`);
            
            // ADF 형식에서 모든 텍스트 추출하는 함수
            function extractAllTextFromADF(node) {
              if (!node) return '';
              
              let text = '';
              if (typeof node === 'string') {
                return node;
              }
              
              if (node.text) {
                text += node.text;
              }
              
              if (node.attrs && node.attrs.href) {
                text += ` ${node.attrs.href} `;
              }
              
              if (node.content && Array.isArray(node.content)) {
                for (const child of node.content) {
                  text += extractAllTextFromADF(child);
                }
              }
              
              return text;
            }
            
            // 코멘트에서 모든 텍스트 및 링크 추출
            const commentText = extractAllTextFromADF(comment.body);
            console.log(`   Comment text preview: "${commentText.substring(0, 150)}${commentText.length > 150 ? '...' : ''}"`);
            
            // 다양한 GitHub 이슈 패턴 검색
            const githubPatterns = [
              /#(\d+)/g,                                                    // #35
              /issues\/(\d+)/g,                                            // issues/35
              /github\.com\/[^\/]+\/[^\/]+\/issues\/(\d+)/g,              // full GitHub URL
              /\[#(\d+)\]/g,                                              // [#35]
              /GitHub\s+이슈:\s*#?(\d+)/gi,                               // Korean text pattern
              /GitHub\s+Issue:\s*#?(\d+)/gi                               // English text pattern
            ];
            
            let hasTargetGithubIssue = false;
            let foundIssueNumbers = new Set();
            
            for (const pattern of githubPatterns) {
              let match;
              while ((match = pattern.exec(commentText)) !== null) {
                const issueNumber = match[1];
                foundIssueNumbers.add(issueNumber);
                
                if (closedIssueNumbers.includes(issueNumber)) {
                  hasTargetGithubIssue = true;
                  console.log(`   ✅ Found target GitHub issue #${issueNumber} in comment`);
                  break;
                }
              }
              if (hasTargetGithubIssue) break;
            }
            
            if (foundIssueNumbers.size > 0) {
              console.log(`   📋 Found GitHub issue references: [${Array.from(foundIssueNumbers).join(', ')}]`);
            }

            if (hasTargetGithubIssue) {
              try {
                console.log(`🗑️ Deleting JIRA comment ${comment.id} (contains GitHub issue reference)`);
                const deleteResponse = await fetch(`${process.env.JIRA_BASE_URL}/rest/api/3/issue/${jiraKey}/comment/${comment.id}`, {
                  method: 'DELETE',
                  headers: {
                    'Authorization': `Basic ${jiraAuth}`,
                    'Accept': 'application/json'
                  }
                });
                
                if (deleteResponse.ok) {
                  console.log(`   ✅ Successfully deleted JIRA comment ${comment.id}`);
                  deletedCommentsCount++;
                } else {
                  const errorText = await deleteResponse.text();
                  console.log(`   ❌ Failed to delete JIRA comment ${comment.id}: ${deleteResponse.status} ${deleteResponse.statusText}`);
                  console.log(`   Error details: ${errorText}`);
                }
              } catch (deleteError) {
                console.log(`   ❌ Error deleting JIRA comment ${comment.id}: ${deleteError.message}`);
              }
            } else {
              console.log(`   ℹ️ Comment ${comment.id} does not contain target GitHub issue references, skipping`);
            }
          }
          
          console.log(`📊 JIRA comment cleanup summary: ${deletedCommentsCount} comments deleted out of ${jiraComments.comments.length} analyzed`);
        } else {
          const errorText = await jiraCommentsResponse.text();
          console.log(`⚠️ Failed to fetch JIRA comments: ${jiraCommentsResponse.status} ${jiraCommentsResponse.statusText}`);
          console.log(`Error details: ${errorText}`);
        }
      } catch (jiraCleanupError) {
        console.log(`⚠️ Error during JIRA comment cleanup: ${jiraCleanupError.message}`);
      }

      console.log(`✅ Cleanup completed for existing issues with JIRA key ${jiraKey}`);
    } else {
      console.log(`ℹ️ No existing open issues found with JIRA key ${jiraKey}`);
    }
  } catch (cleanupError) {
    console.log(`⚠️ Error during cleanup process: ${cleanupError.message}`);
    // 정리 작업이 실패해도 새 이슈 생성은 계속 진행
  }

  console.log(`🆕 Proceeding with new issue creation for ${jiraKey}`);

  // JIRA API로 이슈 정보를 가져와서 customfield_11939에서 reviewer 정보 추출
  let reviewers = [];
  let repoName = '';
  let baseBranch = '';
  let workingFiles = '';
  let instruction = '';
  let issueType = '';
  
  try {
    const jiraAuth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
    const jiraResponse = await fetch(`${process.env.JIRA_BASE_URL}/rest/api/3/issue/${jiraKey}?fields=customfield_11939,issuetype`, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${jiraAuth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
    
    if (jiraResponse.ok) {
      const jiraData = await jiraResponse.json();
      const reviewerField = jiraData.fields.customfield_11939;
      const issueTypeField = jiraData.fields.issuetype;
      
      console.log(`🔍 JIRA customfield_11939 raw value:`, JSON.stringify(reviewerField, null, 2));
      console.log(`🔍 Type of customfield_11939:`, typeof reviewerField);
      
      // 이슈 타입 추출
      if (issueTypeField && issueTypeField.name) {
        issueType = issueTypeField.name;
        console.log(`🏷️ Found JIRA issue type: ${issueType}`);
      } else {
        console.log(`ℹ️ No issue type found in JIRA response`);
      }
      
      // ADF (Atlassian Document Format) 파싱 함수 - 개선된 버전
      function extractTextFromADF(node) {
        if (!node) return '';
        
        let text = '';
        
        // 문자열인 경우 그대로 반환
        if (typeof node === 'string') {
          return node;
        }
        
        // 텍스트 노드 처리
        if (node.text) {
          text += node.text;
        }
        
        // 하드 브레이크 (줄바꿈) 처리
        if (node.type === 'hardBreak') {
          text += '\n';
        }
        
        // 자식 노드들 재귀 처리
        if (node.content && Array.isArray(node.content)) {
          for (const child of node.content) {
            text += extractTextFromADF(child);
          }
        }
        
        // 블록 요소들 뒤에 줄바꿈 추가
        if (node.type === 'paragraph') {
          text += '\n';
        } else if (node.type === 'listItem') {
          text += '\n';
        } else if (node.type === 'heading') {
          text += '\n';
        } else if (node.type === 'codeBlock') {
          text += '\n';
        }
        
        return text;
      }
      
      // ADF를 GitHub Markdown으로 변환하는 함수
      function convertADFToMarkdown(node, depth = 0) {
        if (!node) return '';
        
        let markdown = '';
        const indent = '  '.repeat(depth);
        
        // 문자열인 경우 그대로 반환
        if (typeof node === 'string') {
          return node;
        }
        
        // 노드 타입별 처리
        switch (node.type) {
          case 'doc':
            // 문서 루트
            if (node.content && Array.isArray(node.content)) {
              for (const child of node.content) {
                markdown += convertADFToMarkdown(child, depth);
              }
            }
            break;
            
          case 'paragraph':
            // 단락
            if (node.content && Array.isArray(node.content)) {
              for (const child of node.content) {
                markdown += convertADFToMarkdown(child, depth);
              }
            }
            markdown += '\n\n';
            break;
            
          case 'bulletList':
            // 불릿 리스트
            if (node.content && Array.isArray(node.content)) {
              for (const child of node.content) {
                markdown += convertADFToMarkdown(child, depth);
              }
            }
            break;
            
          case 'orderedList':
            // 순서 리스트
            if (node.content && Array.isArray(node.content)) {
              for (let i = 0; i < node.content.length; i++) {
                const child = node.content[i];
                markdown += convertADFToMarkdown(child, depth, i + 1);
              }
            }
            break;
            
          case 'listItem':
            // 리스트 아이템
            const listMarker = arguments[2] ? `${arguments[2]}.` : '-';
            markdown += `${indent}${listMarker} `;
            
            if (node.content && Array.isArray(node.content)) {
              let itemContent = '';
              for (const child of node.content) {
                if (child.type === 'paragraph') {
                  // 단락의 경우 줄바꿈을 제거하고 인라인으로 처리
                  if (child.content && Array.isArray(child.content)) {
                    for (const textChild of child.content) {
                      itemContent += convertADFToMarkdown(textChild, depth + 1);
                    }
                  }
                } else if (child.type === 'bulletList' || child.type === 'orderedList') {
                  // 중첩된 리스트
                  itemContent += '\n' + convertADFToMarkdown(child, depth + 1);
                } else {
                  itemContent += convertADFToMarkdown(child, depth + 1);
                }
              }
              markdown += itemContent.trim();
            }
            markdown += '\n';
            break;
            
          case 'text':
            // 텍스트 노드
            let text = node.text || '';
            
            // 마크 처리 (굵게, 기울임, 코드 등)
            if (node.marks && Array.isArray(node.marks)) {
              for (const mark of node.marks) {
                switch (mark.type) {
                  case 'strong':
                    text = `**${text}**`;
                    break;
                  case 'em':
                    text = `*${text}*`;
                    break;
                  case 'code':
                    text = `\`${text}\``;
                    break;
                  case 'underline':
                    text = `__${text}__`;
                    break;
                }
              }
            }
            markdown += text;
            break;
            
          case 'hardBreak':
            // 강제 줄바꿈
            markdown += '\n';
            break;
            
          case 'codeBlock':
            // 코드 블록
            markdown += '```\n';
            if (node.content && Array.isArray(node.content)) {
              for (const child of node.content) {
                markdown += convertADFToMarkdown(child, depth);
              }
            }
            markdown += '\n```\n\n';
            break;
            
          default:
            // 기타 노드들은 자식 노드만 처리
            if (node.content && Array.isArray(node.content)) {
              for (const child of node.content) {
                markdown += convertADFToMarkdown(child, depth);
              }
            }
            break;
        }
        
        return markdown;
      }
      
      let extractedText = '';
      let instructionMarkdown = '';
      
      // ADF 객체인지 확인하고 파싱
      if (reviewerField && typeof reviewerField === 'object' && reviewerField.type === 'doc') {
        console.log(`🔍 Detected ADF format, extracting text...`);
        extractedText = extractTextFromADF(reviewerField);
        console.log(`🔍 Extracted text from ADF:`, extractedText);
        
        // Instruction 부분을 Markdown으로 변환
        if (reviewerField.content && Array.isArray(reviewerField.content)) {
          // ADF에서 Instruction 섹션을 찾아서 Markdown으로 변환
          for (const topLevelNode of reviewerField.content) {
            if (topLevelNode.type === 'bulletList' && topLevelNode.content) {
              for (const listItem of topLevelNode.content) {
                if (listItem.type === 'listItem' && listItem.content) {
                  // 각 리스트 아이템에서 "Instruction:" 을 찾기
                  for (const paragraph of listItem.content) {
                    if (paragraph.type === 'paragraph' && paragraph.content) {
                      for (const textNode of paragraph.content) {
                        if (textNode.type === 'text' && textNode.text && 
                            textNode.text.match(/instructions?\s*[:：]/i)) {
                          // Instruction 섹션을 찾았으므로, 해당 리스트 아이템의 중첩된 내용을 변환
                          if (listItem.content.length > 1) {
                            // paragraph 다음에 오는 bulletList를 찾기
                            for (let i = 1; i < listItem.content.length; i++) {
                              if (listItem.content[i].type === 'bulletList') {
                                instructionMarkdown = convertADFToMarkdown(listItem.content[i]);
                                console.log(`📝 Converted Instruction to Markdown:`, instructionMarkdown);
                                break;
                              }
                            }
                          }
                          break;
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      } else if (reviewerField && typeof reviewerField === 'string' && reviewerField.trim().length > 0) {
        console.log(`🔍 Detected string format, using as-is`);
        extractedText = reviewerField;
      } else {
        console.log(`ℹ️ No parseable data found in customfield_11939 field (value: "${reviewerField}")`);
      }
      
      // 추출된 텍스트에서 정보 파싱 - 개선된 버전
      if (extractedText && extractedText.trim().length > 0) {
        // 원본 텍스트를 줄 단위로 분리하되 빈 줄도 보존
        const allLines = extractedText.split('\n');
        // 파싱용으로는 빈 줄 제거된 버전 사용
        const lines = allLines.map(line => line.trim()).filter(line => line.length > 0);
        
        console.log(`🔍 Processing ${lines.length} non-empty lines from ${allLines.length} total lines`);
        console.log(`🔍 Original extracted text:`, JSON.stringify(extractedText));
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          console.log(`🔍 [${i+1}/${lines.length}] Parsing line: "${line}"`);
          
          // 다양한 형태의 라벨을 처리 (대소문자 무시, 특수문자 허용)
          if (line.match(/[-•*]?\s*repo\s*name\s*[:：]\s*/i)) {
            repoName = line.replace(/[-•*]?\s*repo\s*name\s*[:：]\s*/i, '').trim();
            console.log(`📋 Found Repo Name: ${repoName}`);
          } else if (line.match(/[-•*]?\s*base\s*branch\s*[:：]\s*/i)) {
            baseBranch = line.replace(/[-•*]?\s*base\s*branch\s*[:：]\s*/i, '').trim();
            console.log(`🌿 Found Base Branch: ${baseBranch}`);
          } else if (line.match(/[-•*]?\s*reviewers?\s*\(?\s*github\s*username\s*\)?\s*[:：]\s*/i)) {
            const reviewerText = line.replace(/[-•*]?\s*reviewers?\s*\(?\s*github\s*username\s*\)?\s*[:：]\s*/i, '').trim();
            if (reviewerText.length > 0) {
              // 쉼표, 세미콜론, 공백으로 분리하고 각 값의 공백 제거
              reviewers = reviewerText.split(/[,;\s]+/)
                .map(reviewer => reviewer.trim())
                .filter(reviewer => reviewer.length > 0 && reviewer !== '-' && reviewer !== '•' && reviewer !== '*');
              console.log(`👥 Found reviewers: ${reviewers.join(', ')}`);
            }
          } else if (line.match(/[-•*]?\s*working\s*files?\s*[:：]\s*/i)) {
            // Working files 라벨을 찾으면 원본 텍스트에서 해당 위치부터 추출
            const workingFilesLabel = line.match(/[-•*]?\s*working\s*files?\s*[:：]\s*/i)[0];
            const startIndex = extractedText.indexOf(workingFilesLabel);
            const instructionMatch = extractedText.match(/[-•*]?\s*instructions?\s*[:：]\s*/i);
            
            if (startIndex !== -1) {
              let endIndex = extractedText.length;
              if (instructionMatch) {
                const instructionIndex = extractedText.indexOf(instructionMatch[0], startIndex);
                if (instructionIndex > startIndex) {
                  endIndex = instructionIndex;
                }
              }
              
              // 원본 텍스트에서 Working Files 섹션 추출
              let workingFilesSection = extractedText.substring(startIndex, endIndex);
              // 라벨 부분 제거
              workingFilesSection = workingFilesSection.replace(/[-•*]?\s*working\s*files?\s*[:：]\s*/i, '').trim();
              workingFiles = workingFilesSection;
              console.log(`📁 Found Working files from original text: ${workingFiles.substring(0, 200)}${workingFiles.length > 200 ? '...' : ''}`);
            }
          } else if (line.match(/[-•*]?\s*instructions?\s*[:：]\s*/i)) {
            // Instruction 라벨을 찾으면 원본 텍스트에서 해당 위치부터 끝까지 추출
            const instructionLabel = line.match(/[-•*]?\s*instructions?\s*[:：]\s*/i)[0];
            const startIndex = extractedText.indexOf(instructionLabel);
            
            if (startIndex !== -1) {
              // 원본 텍스트에서 Instruction 섹션 추출
              let instructionSection = extractedText.substring(startIndex);
              // 라벨 부분 제거
              instructionSection = instructionSection.replace(/[-•*]?\s*instructions?\s*[:：]\s*/i, '').trim();
              instruction = instructionSection;
              console.log(`📝 Found Instruction from original text: ${instruction.substring(0, 200)}${instruction.length > 200 ? '...' : ''}`);
            }
            
            // Instruction을 찾았으므로 더 이상 처리할 필요 없음
            break;
          }
        }
        
        // Markdown 형식의 Instruction이 있다면 우선 사용
        if (instructionMarkdown && instructionMarkdown.trim().length > 0) {
          instruction = instructionMarkdown.trim();
          console.log(`📝 Using Markdown formatted instruction (${instruction.length} chars)`);
        }
        
  console.log(`📊 Final parsing summary:`);
  console.log(`   - Repo Name: "${repoName}"`);
  console.log(`   - Base Branch: "${baseBranch}"`);
  console.log(`   - Reviewers: [${reviewers.join(', ')}] (${reviewers.length} total)`);
  console.log(`   - Working files: "${workingFiles}"`);
  console.log(`   - Instruction: "${instruction.substring(0, 200)}${instruction.length > 200 ? '...' : ''}"`);
  console.log(`   - Issue Type: "${issueType}"`);
  console.log(`   - Instruction format: ${instructionMarkdown ? 'Markdown' : 'Plain text'}`);
        
      } else {
        console.log(`ℹ️ No structured data found in customfield_11939 field`);
      }
    } else {
      console.log(`⚠️ Failed to fetch JIRA issue: ${jiraResponse.status} ${jiraResponse.statusText}`);
      const errorText = await jiraResponse.text();
      console.log(`Error details: ${errorText}`);
      
      // JIRA API 실패 시에도 GitHub 이슈는 생성하되, 경고 표시
      console.log(`⚠️ JIRA API failed, proceeding with GitHub issue creation without JIRA field data`);
    }
  } catch (jiraError) {
    console.log(`⚠️ Error fetching JIRA issue data:`, {
      message: jiraError.message,
      stack: jiraError.stack,
      name: jiraError.name
    });
    
    // JIRA 연결 실패 시에도 GitHub 이슈는 생성하되, 경고 표시
    console.log(`⚠️ JIRA connection failed, proceeding with GitHub issue creation without JIRA field data`);
  }

  // GitHub 라벨 생성 (기본 라벨 + JIRA 이슈 타입)
  function createGitHubLabels(jiraIssueType) {
    const labels = ['jira-sync', 'copilot-task'];
    
    if (jiraIssueType && jiraIssueType.trim().length > 0) {
      // JIRA 이슈 타입을 GitHub 라벨 형식으로 변환
      const issueTypeLabel = `jira:${jiraIssueType.toLowerCase().replace(/\s+/g, '-')}`;
      labels.push(issueTypeLabel);
      console.log(`🏷️ Added JIRA issue type label: ${issueTypeLabel}`);
    }
    
    return labels;
  }
  
  const githubLabels = createGitHubLabels(issueType);

  // GitHub Issue 본문 생성 (JIRA URL과 MCP 사용 안내 + 파싱된 정보 포함)
  let issueBodyParts = [
    "## 🎯 Issue Request from JIRA",
    "",
    `### 📋 JIRA Issue: [${jiraKey}](${process.env.JIRA_BASE_URL}/browse/${jiraKey}) 🔗`,
    "",
    "**📌 Note:** This issue is linked to a JIRA ticket. Use the MCP server tools below to get comprehensive and up-to-date information.",
    ""
  ];

  // JIRA에서 파싱된 정보가 있으면 추가
  if (repoName || baseBranch || workingFiles || instruction || reviewers.length > 0 || issueType) {
    issueBodyParts.push(
      "### 📊 Copilot Instruction from developer in JIRA (Github Copilot Instruction Field)",
      ""
    );
    
    if (issueType) {
      issueBodyParts.push(`**🏷️ Issue Type:** ${issueType}`);
    }
    if (repoName) {
      issueBodyParts.push(`**🏠 Repository:** ${repoName}`);
    }
    if (baseBranch) {
      issueBodyParts.push(`**🌿 Base Branch:** ${baseBranch}`);
    }
    if (reviewers.length > 0) {
      issueBodyParts.push(`**👥 Reviewers:** ${reviewers.join(', ')}`);
    }
    if (workingFiles) {
      // Working files를 Markdown 코드 블록으로 표시하여 원본 줄바꿈 보존
      issueBodyParts.push(`**📁 Working Files:**`);
      issueBodyParts.push("```");
      issueBodyParts.push(workingFiles);
      issueBodyParts.push("```");
    }
    if (instruction) {
      // Instruction이 이미 Markdown으로 포맷팅되어 있는지 확인
      const isMarkdownFormatted = instruction.includes('- ') || instruction.includes('1. ') || 
                                  instruction.includes('*') || instruction.includes('#');
      
      issueBodyParts.push(`**📝 Developer Instructions:**`);
      
      if (isMarkdownFormatted) {
        // 이미 Markdown으로 포맷팅된 경우 그대로 사용
        issueBodyParts.push("");
        issueBodyParts.push(instruction);
        issueBodyParts.push("");
      } else {
        // Plain text인 경우 코드 블록으로 표시
        issueBodyParts.push("```");
        issueBodyParts.push(instruction);
        issueBodyParts.push("```");
      }
    }
    
    issueBodyParts.push("", "---", "");
  }

  issueBodyParts.push(
    "### 🤖 Instructions for GitHub Copilot",
    "",
    "**🔗 JIRA MCP Server Integration:**",
    "A dedicated JIRA MCP server has been configured for comprehensive issue analysis.",
    "**Use the MCP tools below to get real-time, complete JIRA information.**",
    "",
    "**🛠️ Available MCP Tools:**",
    "- `jira_get_issue(issue_key)`: Get complete issue details including custom fields",
    "- `jira_search(jql)`: Search for related issues using JQL queries",
    "- `jira_download_attachments(issue_key)`: Access attachments and screenshots",
    "",
    "**🔍 Recommended Step-by-Step Process:**",
    `1. **ISSUE ANALYSIS:** Use \`jira_get_issue("${jiraKey}", {"fields": "*all"})\` to get comprehensive issue information with all fields`
  );

  // 파싱된 정보에 따라 맞춤형 지침 추가
  if (baseBranch && baseBranch !== 'main') {
    issueBodyParts.push(`2. **BRANCH SETUP:** Create working branch \`copilot/fix-${jiraKey.toLowerCase()}\` from base branch \`${baseBranch}\``);
  } else {
    issueBodyParts.push(`2. **BRANCH SETUP:** Create working branch \`copilot/fix-${jiraKey.toLowerCase()}\` from main branch`);
  }

  if (instruction) {
    issueBodyParts.push(`3. **TASK EXECUTION:** Follow the detailed developer instructions provided above in the "Developer Instructions" section.`);
    issueBodyParts.push(`   **Key implementation points from the instructions:**`);
    issueBodyParts.push(`   - Review the specific objectives and requirements`);
    issueBodyParts.push(`   - Follow the numbered task items in order`);
    issueBodyParts.push(`   - Pay attention to acceptance criteria`);
    issueBodyParts.push(`   - Ensure migration/deployment considerations are addressed`);
  } else {
    issueBodyParts.push(`3. **DEVELOPER INSTRUCTIONS:** Analyze \`customfield_11939\` from step 1 for detailed developer instructions`);
  }

  if (workingFiles) {
    issueBodyParts.push(`4. **FILE FOCUS:** Pay special attention to working files:`);
    issueBodyParts.push("```");
    issueBodyParts.push(workingFiles);
    issueBodyParts.push("```");
    issueBodyParts.push(`5. **ATTACHMENTS REVIEW:** Use \`jira_download_attachments("${jiraKey}")\` to download and review screenshots and other attachments from the JIRA issue`);
    issueBodyParts.push(`6. **RELATED ISSUES:** Use \`jira_search\` and \`jira_get_issue\` to explore linked/related issues for additional context and clues`);
    issueBodyParts.push(`7. **WORK PLANNING:** Based on steps 1-6, create a detailed work plan with clear understanding of the requirements`);
  } else {
    issueBodyParts.push(`4. **ATTACHMENTS REVIEW:** Use \`jira_download_attachments("${jiraKey}")\` to download and review screenshots and other attachments from the JIRA issue`);
    issueBodyParts.push(`5. **RELATED ISSUES:** Use \`jira_search\` and \`jira_get_issue\` to explore linked/related issues for additional context and clues`);
    issueBodyParts.push(`6. **WORK PLANNING:** Based on steps 1-5, create a detailed work plan with clear understanding of the requirements`);
  }

  issueBodyParts.push(
    "8. **IMPLEMENTATION:** Execute the planned solution following the developer instructions from customfield_11939",
    "9. **TESTING:** Add/update tests to prevent regression and validate the solution",
    `10. **PULL REQUEST:** Create a Pull Request with the following requirements:`,
    `    - **Title Format:** \`[${jiraKey}] <descriptive title>\``,
    `    - **Body Header:** Include JIRA issue URL at the top: ${process.env.JIRA_BASE_URL}/browse/${jiraKey}`,
    `    - **Content:** Detailed explanation including work summary and implementation details`,
    "",
    "### 📋 Checklist",
    "- [ ] JIRA issue details retrieved via MCP server",
    "- [ ] Issue comments and history analyzed",
    "- [ ] Related issues searched and reviewed",
    "- [ ] Requirements and acceptance criteria understood",
    "- [ ] Solution implemented with best practices", 
    "- [ ] Tests added/updated",
    "- [ ] Ready for review",
    "",
    `**🌐 JIRA Issue URL:** [${process.env.JIRA_BASE_URL}/browse/${jiraKey}](${process.env.JIRA_BASE_URL}/browse/${jiraKey})`,
    "",
    "**💡 Note:** Use the MCP server tools for the most up-to-date and comprehensive issue information."
  );

  const issueBody = issueBodyParts.join("\n");
  
  // 새로운 통합 어사이니 관리 모듈 사용
  console.log(`🤖 Creating GitHub issue with integrated assignee management`);
  
  const issueResult = await assigneeManager.createIssueWithAssignees(
    github,
    context,
    `[${jiraKey}] JIRA Issue Request`,
    issueBody,
    githubLabels,
    reviewers,
    false // includeCopilot: false - Copilot은 아래에서 base_ref와 함께 전용 API로 할당
  );
  
  const issue = issueResult.issue;
  const finalAssignees = issueResult.assignees.final;
  const assignmentSuccessful = issueResult.success;
  const validReviewers = issueResult.assignees.validReviewers;
  
  console.log(`✅ Created GitHub issue #${issue.number} via ${issue.method}`);
  console.log(`📊 Assignment result: ${assignmentSuccessful ? 'SUCCESS' : 'PARTIAL/FAILED'}`);
  console.log(`🔍 Final assignees: [${finalAssignees.join(', ')}] (${finalAssignees.length} total)`);
  
  if (issueResult.assignees.invalidReviewers.length > 0) {
    console.log(`⚠️ Invalid reviewers: [${issueResult.assignees.invalidReviewers.join(', ')}]`);
  }

  // Copilot 할당 - agent_assignment.base_branch로 브랜치 지정
  // 공식 API: POST /issues/{number}/assignees + agent_assignment 필드 (public preview)
  // 참고: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/create-a-pr#using-the-rest-api
  let copilotAssigned = false;
  const targetBranch = baseBranch || 'main';
  try {
    console.log(`🤖 Assigning Copilot to issue #${issue.number} with base_branch: "${targetBranch}"`);
    await github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/assignees', {
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issue.number,
      assignees: ['copilot-swe-agent[bot]'],
      agent_assignment: {
        target_repo: `${context.repo.owner}/${context.repo.repo}`,
        base_branch: targetBranch,
        custom_instructions: '',
        custom_agent: '',
        model: ''
      },
      headers: { 'X-GitHub-Api-Version': '2022-11-28' }
    });
    copilotAssigned = true;
    console.log(`✅ Copilot assigned with base_branch: "${targetBranch}"`);
  } catch (copilotError) {
    console.log(`⚠️ Copilot agent_assignment API failed (status: ${copilotError.status}): ${copilotError.message}`);
    console.log(`🔄 Falling back to standard assignee method (base_branch not applied)...`);
    // 폴백: agent_assignment 없이 기본 assignee 방식으로 재시도
    try {
      await github.rest.issues.addAssignees({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: issue.number,
        assignees: ['copilot-swe-agent[bot]']
      });
      copilotAssigned = true;
      console.log(`✅ Copilot assigned via fallback method (base_branch NOT applied — Copilot will use default branch)`);
    } catch (fallbackError) {
      console.log(`❌ Fallback assignment also failed: ${fallbackError.message}`);
    }
  }
  
  // Copilot에게 간결한 할당 알림 댓글 추가
  let commentParts = [];
  
  if (copilotAssigned) {
    // 성공적으로 할당된 경우
    commentParts = [
      `✅ **GitHub Copilot에게 작업이 할당되었습니다!**`,
      `📋 **JIRA 이슈**: [${jiraKey}](${process.env.JIRA_BASE_URL}/browse/${jiraKey})`,
      `🎯 **할당된 사용자**: ${finalAssignees.join(', ')} (총 ${finalAssignees.length}명)`
    ];
    
    // copilot-assigned 라벨 추가
    try {
      await github.rest.issues.addLabels({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: issue.number,
        labels: ['copilot-assigned']
      });
      console.log(`✅ Added 'copilot-assigned' label`);
    } catch (labelError) {
      console.log(`ℹ️ copilot-assigned 라벨 추가 실패 또는 이미 존재: ${labelError.message}`);
    }
    
  } else {
    // 할당에 실패한 경우
    commentParts = [
      `⚠️ **GitHub Copilot 자동 할당에 실패했습니다.**`,
      `� **JIRA 이슈**: [${jiraKey}](${process.env.JIRA_BASE_URL}/browse/${jiraKey})`,
      `🔧 **수동 할당**: 이 이슈에 @copilot을 멘션하거나 Assignees에서 직접 할당해주세요.`
    ];
  }

  await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: issue.number,
    body: commentParts.join("\n")
  });
  
  // JIRA 이슈에 GitHub Copilot 작업 할당 알림 댓글 추가
  try {
    const jiraAuth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
    const githubIssueUrl = `https://github.com/${context.repo.owner}/${context.repo.repo}/issues/${issue.number}`;
    
    const jiraCommentResponse = await fetch(`${process.env.JIRA_BASE_URL}/rest/api/3/issue/${jiraKey}/comment`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${jiraAuth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        body: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "🤖 GitHub Copilot에게 작업이 할당되었습니다."
                }
              ]
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "📋 GitHub 이슈: "
                },
                {
                  type: "text",
                  text: `#${issue.number}`,
                  marks: [
                    {
                      type: "link",
                      attrs: {
                        href: githubIssueUrl
                      }
                    }
                  ]
                }
              ]
            }
          ]
        }
      })
    });
    
    if (jiraCommentResponse.ok) {
      console.log(`✅ Successfully added comment to JIRA issue ${jiraKey}`);
    } else {
      console.log(`⚠️ Failed to add comment to JIRA issue: ${jiraCommentResponse.status} ${jiraCommentResponse.statusText}`);
      const errorText = await jiraCommentResponse.text();
      console.log(`Error details: ${errorText}`);
    }
  } catch (jiraCommentError) {
    console.log(`⚠️ Error adding comment to JIRA issue: ${jiraCommentError.message}`);
  }
  
  return issue.number;
};
